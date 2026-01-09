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
  format_turns: true,
  turn_detection_silence_threshold_ms: 1500,
  word_limit: 50
};
const ASSEMBLYAI_URL = `${ASSEMBLYAI_ENDPOINT}?${querystring.stringify(ASSEMBLYAI_PARAMS)}`;
wss.on('connection', (ws) => {
  console.log('Client connected');
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
      aaiWs.send(JSON.stringify({ type: 'Terminate' }));
    }
    aaiWs.close();
    console.log('Client disconnected');
  });
});
// Endpoint to process transcript with xAI
app.post('/process-transcript', async (req, res) => {
  const { transcript } = req.body;
  if (!transcript) {
    return res.status(400).json({ error: 'Transcript is required' });
  }
  try {
    // Define Zod schema for structured output
    const interviewSchema = z.object({
      transcript: z.string(),
      competitors: z.array(z.string().max(255)),
      objections: z.array(z.object({
        type: z.string().max(50), // 1-word summary
        description: z.string().max(130000),
        address: z.string().max(130000)
      }))
    });
    // Convert to JSON schema
    const jsonSchema = zodToJsonSchema(interviewSchema, 'interview_data');
    // Initialize OpenAI client with xAI base URL
    const openai = new OpenAI({
      apiKey: process.env.XAI_API_KEY,
      baseURL: 'https://api.x.ai/v1'
    });
    // Call xAI API
    const completion = await openai.chat.completions.create({
      model: 'grok-4',
      messages: [
        {
          role: 'system',
          content: `You are a helpful assistant that extracts information from opportunity interview transcripts. Output strictly in JSON matching the schema.
Extract:
- Full transcript as-is.
- Competitors: Array of competitor names mentioned (empty if none).
- Objections: Array of objects with:
  - type: 1-word summary (e.g., "Price", "Features").
  - description: Concise summary of the objection (<130,000 chars).
  - address: Concise summary of how it was overcome (<130,000 chars).
Infer from context; if no competitors or objections, use empty arrays. Output only JSON; no additional text.`
        },
        {
          role: 'user',
          content: `Transcript: ${transcript}`
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'interview_data',
          strict: true,
          schema: jsonSchema
        }
      }
    });
    const jsonOutput = JSON.parse(completion.choices[0].message.content);
    interviewSchema.parse(jsonOutput);
    res.json(jsonOutput);
  } catch (error) {
    console.error('Error processing transcript with xAI:', error);
    res.status(500).json({ error: 'Failed to process transcript' });
  }
});
// Health check endpoint for Heroku and basic access
app.get('/', (req, res) => {
  res.send('Opportunity Interview Backend is running');
});
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});