const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const querystring = require('querystring');
const dotenv = require('dotenv');
const OpenAI = require('openai');
const z = require('zod');
const zodToJsonSchema = require('zod-to-json-schema').default;
const cors = require('cors');

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json()); // Parse JSON bodies
app.use(cors()); // Enable CORS for all routes

const ASSEMBLYAI_ENDPOINT = 'wss://streaming.assemblyai.com/v3/ws';
const ASSEMBLYAI_PARAMS = {
  sample_rate: 16000,
  format_turns: true, // Keep for punctuation in finals
  turn_detection_silence_threshold_ms: 1500, // 1.5s silence to end turn; adjust higher if needed
  word_limit: 50 // Max words per turn; increase for longer chunks
};
const ASSEMBLYAI_URL = `${ASSEMBLYAI_ENDPOINT}?${querystring.stringify(ASSEMBLYAI_PARAMS)}`;

wss.on('connection', (ws) => {
  console.log('Client connected');
  // Open WebSocket to AssemblyAI
  const aaiWs = new WebSocket(ASSEMBLYAI_URL, {
    headers: {
      Authorization: process.env.ASSEMBLYAI_API_KEY
    }
  });

  aaiWs.on('open', () => {
    console.log('Connected to AssemblyAI');
  });

  aaiWs.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'Turn') {
        const messageType = data.turn_is_formatted ? 'FinalTranscript' : 'PartialTranscript';
        ws.send(JSON.stringify({
          type: 'transcript',
          message_type: messageType,
          text: data.transcript || ''
        }));
      } else if (data.type === 'Termination') {
        console.log(`AssemblyAI session terminated: ${data.audio_duration_seconds}s processed`);
      }
    } catch (error) {
      console.error('Error parsing AssemblyAI message:', error);
    }
  });

  aaiWs.on('error', (error) => {
    console.error('AssemblyAI WebSocket error:', error);
  });

  aaiWs.on('close', (code, reason) => {
    console.log(`AssemblyAI WebSocket closed: ${code} - ${reason}`);
  });

  ws.on('message', (message) => {
    if (Buffer.isBuffer(message) && aaiWs.readyState === WebSocket.OPEN) {
      aaiWs.send(message);
    }
  });

  ws.on('close', () => {
    if (aaiWs.readyState === WebSocket.OPEN) {
      // Send termination message to AssemblyAI
      aaiWs.send(JSON.stringify({ type: 'Terminate' }));
    }
    aaiWs.close();
    console.log('Client disconnected');
  });
});

// Endpoint to process transcript with xAI for JSON output
app.post('/process-transcript', async (req, res) => {
  const { transcript, model } = req.body;
  const selectedModel = model || 'grok-4-1-fast-reasoning'; // Updated to current valid model

  if (!transcript) {
    return res.status(400).json({ error: 'Transcript is required' });
  }

  try {
    // Define Zod schema for structured output
    const interviewSchema = z.object({
      transcript: z.string(),
      competitors: z.array(z.object({
        name: z.string().max(255)
      })),
      objections: z.array(z.object({
        type: z.string().max(50), // 1-word summary
        description: z.string().max(130000),
        address: z.string().max(130000)
      }))
    });

    // Convert Zod schema to JSON schema for xAI API
    const jsonSchema = zodToJsonSchema(interviewSchema, 'opportunity_interview');

    // Initialize OpenAI client with xAI base URL
    const openai = new OpenAI({
      apiKey: process.env.XAI_API_KEY,
      baseURL: 'https://api.x.ai/v1'
    });

    // Call xAI API with structured output
    const completion = await openai.chat.completions.create({
      model: selectedModel,
      messages: [
        {
          role: 'system',
          content: `You are a helpful assistant that extracts information from opportunity interview transcripts and outputs strictly in JSON format matching the provided schema.

Extract from the transcript:
- Full transcript as-is.
- Competitors: Array of unique competitor names mentioned (e.g., "Salesforce", "HubSpot"). If none, empty array.
- Objections: Array of objections with:
  - type: A single-word summary (e.g., "Price", "Features").
  - description: Concise summary of the objection (<130,000 chars).
  - address: Concise summary of how it was overcome (<130,000 chars).
If no competitors or objections, use empty arrays. Infer based on context after questions like "Were there any competitors?" and "Did you face any objections?".

Output only the JSON object matching the schema; no additional text.`
        },
        {
          role: 'user',
          content: `Transcript: ${transcript}`
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'opportunity_interview',
          strict: true,
          schema: jsonSchema
        }
      }
    });

    // Parse the JSON response
    const jsonOutput = JSON.parse(completion.choices[0].message.content);

    // Validate with Zod
    interviewSchema.parse(jsonOutput);

    res.json(jsonOutput);
  } catch (error) {
    console.error('Error processing transcript with xAI:', error.stack); // Enhanced logging
    res.status(500).json({ error: 'Failed to process transcript' });
  }
});

// Health check endpoint for Heroku
app.get('/', (req, res) => {
  res.send('Heroku app is running');
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});