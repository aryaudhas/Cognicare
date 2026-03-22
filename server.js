// ============================================================
//  CogniCare — Express Backend (Google Gemini)
//  AUTO MODEL DETECTION + JSON Data Analysis
//  Required: GEMINI_API_KEY — free at aistudio.google.com
// ============================================================

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const fetch   = require('node-fetch');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Correct model names from the API list
const MODEL_CANDIDATES = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-lite-001',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-pro-latest',
  'gemini-2.5-pro',
];

const genAI       = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
let   activeModel = null;

// ── AUTO DETECT WORKING MODEL ─────────────────────────────────
async function detectWorkingModel() {
  if (!genAI) { console.log('  ⚠  No GEMINI_API_KEY set'); return null; }
  console.log('  🔍 Auto-detecting working Gemini model...');
  for (const modelId of MODEL_CANDIDATES) {
    try {
      const model  = genAI.getGenerativeModel({ model: modelId });
      const result = await model.generateContent('Say ok');
      if (result.response.text()) {
        console.log(`  ✓  Working model: ${modelId}`);
        return modelId;
      }
    } catch (e) {
      console.log(`  ✗  ${modelId}: ${e.message.slice(0, 80)}`);
    }
  }
  console.log('  ✗  No working model found — check your API key');
  return null;
}

// ── DB ────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { console.warn('DB load error, using defaults'); }
  return {
    patients: [{
      id: 'P001', name: 'Margaret Thompson', age: 78, stage: 'Moderate',
      caregiver: 'Susan Thompson', phone: '(416) 555-0123',
      notes: 'Former schoolteacher. Enjoys classical music and gardening. Trouble with recent memory but long-term memory intact.',
      createdAt: new Date().toISOString()
    }],
    reminders: [
      { id:'R001', patientId:'P001', type:'meal',       label:'Breakfast',           time:'08:00', days:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active:true, createdAt:new Date().toISOString() },
      { id:'R002', patientId:'P001', type:'medication', label:'Morning medication',   time:'09:00', days:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active:true, createdAt:new Date().toISOString() },
      { id:'R003', patientId:'P001', type:'meal',       label:'Lunch',               time:'12:30', days:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active:true, createdAt:new Date().toISOString() },
      { id:'R004', patientId:'P001', type:'bathroom',   label:'Bathroom break',      time:'14:00', days:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active:true, createdAt:new Date().toISOString() },
      { id:'R005', patientId:'P001', type:'medication', label:'Afternoon medication', time:'15:00', days:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active:true, createdAt:new Date().toISOString() },
      { id:'R006', patientId:'P001', type:'meal',       label:'Dinner',              time:'18:00', days:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active:true, createdAt:new Date().toISOString() },
      { id:'R007', patientId:'P001', type:'hydration',  label:'Drink water',         time:'10:00', days:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active:true, createdAt:new Date().toISOString() },
      { id:'R008', patientId:'P001', type:'activity',   label:'Short walk outside',  time:'11:00', days:['Mon','Wed','Fri'],                        active:true, createdAt:new Date().toISOString() },
    ],
    activity: [
      { id:'A001', patientId:'P001', type:'reminder_sent', message:'Breakfast reminder sent',                                 timestamp:new Date(Date.now()-7200000).toISOString() },
      { id:'A002', patientId:'P001', type:'analysis',      message:'Image analysis completed — no concerning signs observed', timestamp:new Date(Date.now()-18000000).toISOString() },
      { id:'A003', patientId:'P001', type:'chat',          message:'Patient used AI assistant',                               timestamp:new Date(Date.now()-28800000).toISOString() },
    ]
  };
}

function saveDB() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function logActivity(patientId, type, message) {
  db.activity.unshift({ id:`A${Date.now()}`, patientId, type, message, timestamp:new Date().toISOString() });
  if (db.activity.length > 200) db.activity = db.activity.slice(0, 200);
  saveDB();
}

let db = loadDB();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Gemini helpers ────────────────────────────────────────────
function requireAI() {
  if (!genAI || !activeModel) {
    throw new Error(
      !genAI
        ? 'GEMINI_API_KEY not set. Get your free key at aistudio.google.com'
        : 'No working Gemini model found. Check your API key.'
    );
  }
}

function cleanJSON(text) {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
}

async function tryModels(fn) {
  if (activeModel) {
    try { return await fn(activeModel); }
    catch (e) {
      if (!e.message.includes('404') && !e.message.includes('429') && !e.message.includes('not found')) throw e;
      console.warn(`Model ${activeModel} failed, trying others...`);
    }
  }
  for (const modelId of MODEL_CANDIDATES) {
    if (modelId === activeModel) continue;
    try {
      const result = await fn(modelId);
      activeModel  = modelId;
      return result;
    } catch (e) {
      if (!e.message.includes('404') && !e.message.includes('429') && !e.message.includes('not found')) throw e;
    }
  }
  throw new Error('No working Gemini model available. Check your API key at aistudio.google.com');
}

async function geminiText(prompt, systemInstruction = '') {
  requireAI();
  return tryModels(async (modelId) => {
    const model  = genAI.getGenerativeModel({ model: modelId, ...(systemInstruction ? { systemInstruction } : {}) });
    const result = await model.generateContent(prompt);
    return result.response.text();
  });
}

async function geminiChat(history, systemInstruction = '') {
  requireAI();
  return tryModels(async (modelId) => {
    const model = genAI.getGenerativeModel({ model: modelId, ...(systemInstruction ? { systemInstruction } : {}) });
    const geminiHistory = history.slice(0, -1).map(m => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
    const chat   = model.startChat({ history: geminiHistory });
    const result = await chat.sendMessage(history[history.length - 1].content);
    return result.response.text();
  });
}

async function geminiVision(imageParts, prompt) {
  requireAI();
  return tryModels(async (modelId) => {
    const model  = genAI.getGenerativeModel({ model: modelId });
    const result = await model.generateContent([...imageParts, { text: prompt }]);
    return result.response.text();
  });
}

// ── YouTube helpers ───────────────────────────────────────────
function extractYouTubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /youtube\.com\/shorts\/([^&\n?#]+)/
  ];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  return null;
}

async function getYouTubeData(videoId) {
  const thumbUrls = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
  ];
  const images = [];
  for (const url of thumbUrls) {
    try {
      const res = await fetch(url); if (!res.ok) continue;
      const buf = await res.buffer(); if (buf.length < 5000) continue;
      images.push({ data: buf.toString('base64'), mediaType: 'image/jpeg' });
    } catch { }
  }
  let metadata = { title: 'Unknown', author: 'Unknown' };
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (r.ok) { const d = await r.json(); metadata.title = d.title||'Unknown'; metadata.author = d.author_name||'Unknown'; }
  } catch { }
  return { images, metadata, videoId, videoUrl:`https://www.youtube.com/watch?v=${videoId}` };
}

// ── API: AI STATUS ────────────────────────────────────────────
app.get('/api/ai-status', (req, res) => {
  res.json({
    hasKey:      !!genAI,
    activeModel: activeModel || 'none',
    ready:       !!(genAI && activeModel),
    status:      genAI && activeModel ? `✓ Ready — ${activeModel}` : !genAI ? '✗ No API key' : '✗ No working model'
  });
});

// ── API: JSON ANALYZE ─────────────────────────────────────────
// Accepts any JSON data (sensor readings, health logs, observation data etc.)
// Returns a daily summary + prioritised alerts
app.post('/api/json-analyze', async (req, res) => {
  const { jsonData, patientId, dataType, date } = req.body;

  if (!jsonData) return res.status(400).json({ error: 'No JSON data provided' });

  // Parse if string, use as-is if already object
  let parsedData;
  try {
    parsedData = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON — please check the format and try again' });
  }

  try {
    const patient = db.patients.find(p => p.id === patientId);

    const prompt = `You are a compassionate AI assistant specializing in cognitive decline patient monitoring.
You have been given structured JSON data about a patient and must produce a daily summary and alert list.

Patient: ${patient ? `${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}. Notes: ${patient.notes}` : 'Unknown patient'}
Data type: ${dataType || 'General health/observation data'}
Date: ${date || new Date().toLocaleDateString('en-CA')}

JSON Data to analyze:
${JSON.stringify(parsedData, null, 2)}

Based on this data, return ONLY this JSON structure with no markdown:
{
  "dailySummary": {
    "overview": "2-3 sentence warm human-readable overview of the patient's day/status",
    "overallStatus": "good|fair|concerning|critical",
    "keyFindings": ["finding 1", "finding 2", "finding 3"],
    "positives": ["positive observation 1", "positive observation 2"],
    "concerns": ["concern 1", "concern 2"]
  },
  "alerts": [
    {
      "priority": "low|medium|high|critical",
      "category": "medication|nutrition|hydration|mobility|cognitive|safety|social|sleep|other",
      "title": "Short alert title",
      "description": "Detailed description of what was detected and why it matters",
      "action": "Specific recommended action for the caregiver"
    }
  ],
  "recommendations": [
    {
      "timeframe": "immediate|today|this_week",
      "text": "Specific actionable recommendation"
    }
  ],
  "metricsExtracted": {
    "anyKeyMetricFound1": "value",
    "anyKeyMetricFound2": "value"
  },
  "nextCheckIn": "When the caregiver should next check on the patient based on this data"
}

Sort alerts by priority (critical first). Be thorough, compassionate, and clinically useful.
If the data contains normal readings with nothing concerning, say so clearly with positive reinforcement.`;

    const raw   = await geminiText(prompt);
    const clean = cleanJSON(raw);
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI did not return valid JSON — please try again');
    const result = JSON.parse(match[0]);

    // Log the activity
    const alertCount = result.alerts?.length || 0;
    const highAlerts = result.alerts?.filter(a => a.priority === 'high' || a.priority === 'critical').length || 0;
    logActivity(
      patientId || 'unknown', 'json_analysis',
      `JSON analysis: ${result.dailySummary?.overallStatus || 'unknown'} — ${alertCount} alerts (${highAlerts} high/critical)`
    );

    res.json({ success: true, result, modelUsed: activeModel });

  } catch (e) {
    console.error('JSON analyze error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: YOUTUBE INFO ─────────────────────────────────────────
app.post('/api/youtube-info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const videoId = extractYouTubeId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });
  try {
    const data = await getYouTubeData(videoId);
    res.json({ success: true, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: ANALYZE IMAGES / YOUTUBE ────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { images, patientId, patientName, context, youtubeUrl } = req.body;
  let imagesToAnalyze = images || [];
  let videoContext    = context || '';

  if (youtubeUrl) {
    try {
      const videoId = extractYouTubeId(youtubeUrl);
      if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });
      const ytData    = await getYouTubeData(videoId);
      imagesToAnalyze = [...imagesToAnalyze, ...ytData.images];
      videoContext    = `YouTube video: "${ytData.metadata.title}" by ${ytData.metadata.author}. ${context || ''}`;
    } catch (e) { return res.status(500).json({ error: `YouTube fetch failed: ${e.message}` }); }
  }

  if (!imagesToAnalyze.length) return res.status(400).json({ error: 'No images provided' });

  try {
    const patient = db.patients.find(p => p.id === patientId);
    const name    = patientName || patient?.name || 'the patient';

    const imageParts = imagesToAnalyze.slice(0, 4).map(img => ({
      inlineData: { data: img.data, mimeType: img.mediaType || 'image/jpeg' }
    }));

    const prompt = `You are a compassionate AI medical assistant specializing in cognitive decline monitoring.
Analyze this image/video of ${name} and return ONLY this JSON with no markdown:

Patient: ${patient ? `${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}, Notes: ${patient.notes}` : 'Unknown'}
${videoContext ? `Context: ${videoContext}` : ''}

{
  "observations": ["observation 1", "observation 2"],
  "cognitiveIndicators": {
    "confusion": "none|mild|moderate|severe",
    "agitation": "none|mild|moderate|severe",
    "disorientation": "none|mild|moderate|severe",
    "expressionConcern": "none|mild|moderate|severe"
  },
  "physicalIndicators": {
    "posture": "description",
    "mobility": "description",
    "grooming": "description",
    "fatigue": "none|mild|moderate|severe"
  },
  "immediateNeeds": ["need 1"],
  "recommendations": ["recommendation 1"],
  "urgency": "routine|attention|urgent",
  "summary": "Warm 2-3 sentence summary for the caregiver",
  "safetyFlags": []
}`;

    const raw      = await geminiVision(imageParts, prompt);
    const clean    = cleanJSON(raw);
    const match    = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI did not return valid JSON — please try again');
    const analysis = JSON.parse(match[0]);

    logActivity(patientId || 'unknown', 'analysis',
      `Analysis (${youtubeUrl ? 'YouTube' : 'image'}): ${analysis.urgency} — ${(analysis.summary || '').slice(0, 80)}`);

    res.json({ success: true, analysis, modelUsed: activeModel });
  } catch (e) {
    console.error('Analysis error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: CHAT ─────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, patientId, mode } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'No messages' });

  try {
    const patient   = db.patients.find(p => p.id === patientId);
    const reminders = db.reminders.filter(r => r.patientId === patientId && r.active);

    const systemInstruction = mode === 'patient'
      ? `You are a warm gentle AI companion for ${patient?.name || 'a person'} who has cognitive decline.
- Speak in SIMPLE SHORT sentences. Max 3 sentences per response.
- Be extremely warm, reassuring and positive at all times.
- If confused, gently orient them by telling them the day and time.
- If they mention pain, a fall, or distress, tell them to press the red emergency button immediately.
- Use their first name often. Never correct harshly — redirect gently.
Patient: ${patient ? `${patient.name}, Age ${patient.age}, Stage: ${patient.stage}` : 'Unknown'}
Reminders today: ${reminders.map(r => `${r.time} — ${r.label}`).join(', ') || 'None'}`
      : `You are an expert compassionate AI assistant for caregivers managing cognitive decline patients.
You help with behavioral changes, care strategies, communication techniques, managing agitation and sundowning,
caregiver burnout, understanding disease stages, safety assessments, and activities for cognitive stimulation.
Always be evidence-based and remind caregivers to consult medical professionals for clinical decisions.
Patient: ${patient ? `${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}. Notes: ${patient.notes}` : 'Not specified'}`;

    const response = await geminiChat(messages, systemInstruction);
    logActivity(patientId || 'unknown', 'chat', `${mode === 'patient' ? 'Patient' : 'Caregiver'} used AI assistant`);
    res.json({ success: true, response, modelUsed: activeModel });
  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: SUGGEST REMINDERS ────────────────────────────────────
app.post('/api/suggest-reminders', async (req, res) => {
  const { patientId } = req.body;
  const patient = db.patients.find(p => p.id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  try {
    const prompt = `Generate a personalized daily reminder schedule for this cognitive decline patient:
Name: ${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}
Background: ${patient.notes}

Return ONLY a JSON array. Each item must have:
- type: meal|medication|bathroom|hydration|activity|social|sleep|grooming
- label: warm friendly short description
- time: HH:MM 24hr format
- days: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]

8-12 reminders spread across the day. JSON array ONLY, no markdown.`;

    const raw   = await geminiText(prompt);
    const clean = cleanJSON(raw);
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Could not parse suggestions');
    res.json({ success: true, suggestions: JSON.parse(match[0]), modelUsed: activeModel });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATIENTS ──────────────────────────────────────────────────
app.get('/api/patients',     (req, res) => res.json(db.patients));
app.get('/api/patients/:id', (req, res) => { const p = db.patients.find(p => p.id === req.params.id); if (!p) return res.status(404).json({ error:'Not found' }); res.json(p); });
app.post('/api/patients', (req, res) => {
  const { name, age, stage, caregiver, phone, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const p = { id:`P${Date.now()}`, name, age:age||'', stage:stage||'Mild', caregiver:caregiver||'', phone:phone||'', notes:notes||'', createdAt:new Date().toISOString() };
  db.patients.push(p); saveDB(); res.status(201).json(p);
});
app.patch('/api/patients/:id', (req, res) => {
  const p = db.patients.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  ['name','age','stage','caregiver','phone','notes'].forEach(f => { if (req.body[f] !== undefined) p[f] = req.body[f]; });
  saveDB(); res.json(p);
});
app.delete('/api/patients/:id', (req, res) => {
  const idx = db.patients.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.patients.splice(idx, 1); saveDB(); res.json({ deleted: true });
});

// ── REMINDERS ─────────────────────────────────────────────────
app.get('/api/reminders', (req, res) => { const { patientId } = req.query; res.json(patientId ? db.reminders.filter(r => r.patientId === patientId) : db.reminders); });
app.post('/api/reminders', (req, res) => {
  const { patientId, type, label, time, days } = req.body;
  if (!patientId || !type || !label || !time) return res.status(400).json({ error: 'Missing fields' });
  const r = { id:`R${Date.now()}`, patientId, type, label, time, days:days||['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active:true, createdAt:new Date().toISOString() };
  db.reminders.push(r); saveDB(); res.status(201).json(r);
});
app.patch('/api/reminders/:id', (req, res) => {
  const r = db.reminders.find(r => r.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  ['type','label','time','days','active'].forEach(f => { if (req.body[f] !== undefined) r[f] = req.body[f]; });
  saveDB(); res.json(r);
});
app.delete('/api/reminders/:id', (req, res) => {
  const idx = db.reminders.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.reminders.splice(idx, 1); saveDB(); res.json({ deleted: true });
});

// ── ACTIVITY + STATS ──────────────────────────────────────────
app.get('/api/activity', (req, res) => {
  const { patientId, limit } = req.query;
  let logs = patientId ? db.activity.filter(a => a.patientId === patientId) : db.activity;
  if (limit) logs = logs.slice(0, parseInt(limit));
  res.json(logs);
});
app.post('/api/activity', (req, res) => { logActivity(req.body.patientId, req.body.type, req.body.message); res.status(201).json({ logged: true }); });
app.get('/api/stats', (req, res) => {
  res.json({
    patients:        db.patients.length,
    activeReminders: db.reminders.filter(r => r.active).length,
    activityToday:   db.activity.filter(a => new Date(a.timestamp) > new Date(Date.now() - 86400000)).length,
    totalActivity:   db.activity.length
  });
});

// ── CATCH-ALL ─────────────────────────────────────────────────
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('');
  console.log('  🧠  CogniCare AI Assistant');
  console.log(`  ●   http://localhost:${PORT}`);
  console.log(`  🔑  API Key: ${GEMINI_API_KEY ? '✓ Set' : '✗ Missing — get free key at aistudio.google.com'}`);
  console.log('');
  if (GEMINI_API_KEY) {
    activeModel = await detectWorkingModel();
    if (activeModel) console.log(`  🚀  Ready — using: ${activeModel}`);
    else console.log('  ⚠   No working model found. Check your API key.');
  }
  console.log('');
});
