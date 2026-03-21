// ============================================================
//  CogniCare — Express Backend (Google Gemini)
//
//  Required environment variable:
//    GEMINI_API_KEY  — get your FREE key at aistudio.google.com
//
//  Optional environment variable:
//    GEMINI_MODEL    — which Gemini model to use (default below)
//
//  Available FREE Gemini models (as of 2025):
//    gemini-1.5-flash          ← default, fastest, great for chat
//    gemini-1.5-flash-8b       ← smallest/cheapest, still capable
//    gemini-1.5-pro            ← most capable, higher quota cost
//    gemini-2.0-flash-exp      ← latest experimental, very capable
//    gemini-2.0-flash-lite     ← lightest of the 2.0 family
//
//  Just set GEMINI_MODEL=gemini-2.0-flash-exp in your
//  environment variables to switch models with no code change.
// ============================================================

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const fetch   = require('node-fetch');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Model config ──────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || 'gemini-1.5-flash';

// All currently available free Gemini models
const AVAILABLE_MODELS = [
  { id: 'gemini-1.5-flash',     label: 'Gemini 1.5 Flash',      desc: 'Default — fast, reliable, great all-rounder' },
  { id: 'gemini-1.5-flash-8b',  label: 'Gemini 1.5 Flash 8B',   desc: 'Smallest model, lowest latency' },
  { id: 'gemini-1.5-pro',       label: 'Gemini 1.5 Pro',        desc: 'Most capable 1.5 model, best analysis' },
  { id: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash (Exp)', desc: 'Latest experimental, very capable' },
  { id: 'gemini-2.0-flash-lite',label: 'Gemini 2.0 Flash Lite',  desc: 'Lightweight 2.0 model, quick responses' },
];

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

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

function requireGemini() {
  if (!genAI) {
    throw new Error(
      'GEMINI_API_KEY is not set. ' +
      'Get your free key at aistudio.google.com, then add it as an environment variable.'
    );
  }
}

// Strip markdown code fences Gemini sometimes adds
function cleanJSON(text) {
  return text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
}

// Simple single-turn text generation
async function geminiText(prompt, systemInstruction = '', modelOverride = null) {
  requireGemini();
  const model = genAI.getGenerativeModel({
    model: modelOverride || GEMINI_MODEL,
    ...(systemInstruction ? { systemInstruction } : {})
  });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

// Multi-turn chat
async function geminiChat(history, systemInstruction = '', modelOverride = null) {
  requireGemini();
  const model = genAI.getGenerativeModel({
    model: modelOverride || GEMINI_MODEL,
    ...(systemInstruction ? { systemInstruction } : {})
  });

  // Convert to Gemini format: 'user' | 'model'
  const geminiHistory = history.slice(0, -1).map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const chat   = model.startChat({ history: geminiHistory });
  const result = await chat.sendMessage(history[history.length - 1].content);
  return result.response.text();
}

// Multimodal image + text generation (vision)
async function geminiVision(imageParts, prompt, modelOverride = null) {
  requireGemini();
  // Always use a vision-capable model
  // gemini-1.5-flash and gemini-1.5-pro both support vision
  // gemini-2.0-flash-exp also supports vision
  const visionModel = modelOverride || GEMINI_MODEL;
  const model  = genAI.getGenerativeModel({ model: visionModel });
  const parts  = [...imageParts, { text: prompt }];
  const result = await model.generateContent(parts);
  return result.response.text();
}

// ── YouTube helpers ───────────────────────────────────────────

function extractYouTubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /youtube\.com\/shorts\/([^&\n?#]+)/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
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
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = await res.buffer();
      if (buf.length < 5000) continue; // skip tiny placeholder images
      images.push({ data: buf.toString('base64'), mediaType: 'image/jpeg' });
    } catch { /* skip */ }
  }

  let metadata = { title: 'Unknown', author: 'Unknown' };
  try {
    const oembed = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (oembed.ok) {
      const d = await oembed.json();
      metadata.title  = d.title       || 'Unknown';
      metadata.author = d.author_name || 'Unknown';
    }
  } catch { /* ignore */ }

  return { images, metadata, videoId, videoUrl: `https://www.youtube.com/watch?v=${videoId}` };
}

// ── API: AI STATUS ────────────────────────────────────────────
app.get('/api/ai-status', (req, res) => {
  res.json({
    hasKey:          !!genAI,
    activeModel:     GEMINI_MODEL,
    availableModels: AVAILABLE_MODELS,
    status:          genAI ? `✓ Ready — ${GEMINI_MODEL}` : '✗ No API key'
  });
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: ANALYZE IMAGES / YOUTUBE ────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { images, patientId, patientName, context, youtubeUrl, model: modelOverride } = req.body;

  let imagesToAnalyze = images || [];
  let videoContext    = context || '';

  if (youtubeUrl) {
    try {
      const videoId = extractYouTubeId(youtubeUrl);
      if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });
      const ytData   = await getYouTubeData(videoId);
      imagesToAnalyze = [...imagesToAnalyze, ...ytData.images];
      videoContext    = `YouTube video: "${ytData.metadata.title}" by ${ytData.metadata.author}. ${context || ''}`;
    } catch (e) {
      return res.status(500).json({ error: `YouTube fetch failed: ${e.message}` });
    }
  }

  if (!imagesToAnalyze.length) return res.status(400).json({ error: 'No images provided' });

  try {
    const patient = db.patients.find(p => p.id === patientId);
    const name    = patientName || patient?.name || 'the patient';

    const imageParts = imagesToAnalyze.slice(0, 4).map(img => ({
      inlineData: { data: img.data, mimeType: img.mediaType || 'image/jpeg' }
    }));

    const prompt = `You are a compassionate AI medical assistant specializing in cognitive decline monitoring.
Carefully analyze this image/video of ${name} and return a structured JSON assessment.

Patient details: ${patient ? `Name: ${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}, Notes: ${patient.notes}` : 'Unknown patient'}
${videoContext ? `Context provided: ${videoContext}` : ''}

Return ONLY this JSON structure with no other text, no markdown fences:
{
  "observations": ["specific observation 1", "specific observation 2"],
  "cognitiveIndicators": {
    "confusion": "none|mild|moderate|severe",
    "agitation": "none|mild|moderate|severe",
    "disorientation": "none|mild|moderate|severe",
    "expressionConcern": "none|mild|moderate|severe"
  },
  "physicalIndicators": {
    "posture": "description of posture",
    "mobility": "description of mobility",
    "grooming": "description of grooming/appearance",
    "fatigue": "none|mild|moderate|severe"
  },
  "immediateNeeds": ["need 1", "need 2"],
  "recommendations": ["recommendation 1", "recommendation 2"],
  "urgency": "routine|attention|urgent",
  "summary": "A warm, compassionate 2-3 sentence paragraph summarizing findings for the caregiver",
  "safetyFlags": []
}

Be thorough, compassionate, and always err on the side of caution when assessing safety.`;

    const raw      = await geminiVision(imageParts, prompt, modelOverride);
    const clean    = cleanJSON(raw);
    const match    = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI did not return valid JSON — try again');
    const analysis = JSON.parse(match[0]);

    logActivity(patientId || 'unknown', 'analysis',
      `Analysis (${youtubeUrl ? 'YouTube' : 'image'}): ${analysis.urgency} — ${(analysis.summary||'').slice(0,80)}`);

    res.json({ success: true, analysis, modelUsed: modelOverride || GEMINI_MODEL });

  } catch (e) {
    console.error('Analysis error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: CHAT ─────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, patientId, mode, model: modelOverride } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'No messages' });

  try {
    const patient   = db.patients.find(p => p.id === patientId);
    const reminders = db.reminders.filter(r => r.patientId === patientId && r.active);

    let systemInstruction = '';

    if (mode === 'patient') {
      systemInstruction =
        `You are a warm, gentle AI companion for ${patient?.name || 'a person'} who has cognitive decline.
RULES:
- Speak in SIMPLE, SHORT sentences. Maximum 3 sentences per response.
- Be extremely warm, reassuring, and positive at all times.
- If they seem confused, gently orient them: tell them the day and time.
- If they mention pain, a fall, or distress, tell them to press the red emergency button immediately.
- Never correct harshly — always redirect gently and with kindness.
- Use their first name often to keep them grounded.
- If they want to talk about family, memories, or interests, engage warmly.
Patient info: ${patient ? `${patient.name}, Age ${patient.age}, Stage: ${patient.stage}` : 'Unknown'}
Reminders today: ${reminders.map(r=>`${r.time} — ${r.label}`).join(', ') || 'None scheduled'}`;
    } else {
      systemInstruction =
        `You are an expert AI assistant for caregivers managing patients with cognitive decline.
You are knowledgeable, empathetic, and practical. You help with:
- Understanding and interpreting behavioral changes
- Evidence-based communication strategies for dementia patients
- Managing challenging behaviors (agitation, sundowning, wandering)
- Self-care and burnout prevention for caregivers
- Understanding disease stages and what to expect
- Medication management tips (always recommend consulting a doctor)
- Activities that stimulate cognition and improve quality of life
- Safety assessment and home modification advice
Always be compassionate, evidence-based, and remind caregivers to consult medical professionals for clinical decisions.
Patient being cared for: ${patient ? `${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}. Background: ${patient.notes}` : 'Not specified'}`;
    }

    const response = await geminiChat(messages, systemInstruction, modelOverride);

    logActivity(patientId || 'unknown', 'chat',
      `${mode === 'patient' ? 'Patient' : 'Caregiver'} used AI assistant`);

    res.json({ success: true, response, modelUsed: modelOverride || GEMINI_MODEL });

  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: SUGGEST REMINDERS ────────────────────────────────────
app.post('/api/suggest-reminders', async (req, res) => {
  const { patientId, model: modelOverride } = req.body;
  const patient = db.patients.find(p => p.id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  try {
    const prompt =
      `You are a care planning AI. Generate a personalized daily reminder schedule for this patient:
Name: ${patient.name}
Age: ${patient.age}
Cognitive decline stage: ${patient.stage}
Background and notes: ${patient.notes}

Create a schedule tailored to their specific needs, stage, and background.
Return ONLY a JSON array. Each item must have exactly these fields:
- type: one of meal|medication|bathroom|hydration|activity|social|sleep|grooming
- label: a warm, friendly short description (e.g. "Time for your morning tea and breakfast")
- time: HH:MM in 24hr format
- days: array like ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]

Include 8-12 reminders spread sensibly across the day.
Respond with the JSON array ONLY. No markdown, no explanation.`;

    const raw     = await geminiText(prompt, '', modelOverride);
    const clean   = cleanJSON(raw);
    const match   = clean.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Could not parse AI suggestions');
    const suggestions = JSON.parse(match[0]);
    res.json({ success: true, suggestions, modelUsed: modelOverride || GEMINI_MODEL });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PATIENTS ──────────────────────────────────────────────────
app.get('/api/patients',     (req, res) => res.json(db.patients));
app.get('/api/patients/:id', (req, res) => {
  const p = db.patients.find(p=>p.id===req.params.id);
  if (!p) return res.status(404).json({ error:'Not found' });
  res.json(p);
});
app.post('/api/patients', (req, res) => {
  const { name, age, stage, caregiver, phone, notes } = req.body;
  if (!name) return res.status(400).json({ error:'Name required' });
  const p = { id:`P${Date.now()}`, name, age:age||'', stage:stage||'Mild', caregiver:caregiver||'', phone:phone||'', notes:notes||'', createdAt:new Date().toISOString() };
  db.patients.push(p); saveDB(); res.status(201).json(p);
});
app.patch('/api/patients/:id', (req, res) => {
  const p = db.patients.find(p=>p.id===req.params.id);
  if (!p) return res.status(404).json({ error:'Not found' });
  ['name','age','stage','caregiver','phone','notes'].forEach(f=>{ if(req.body[f]!==undefined) p[f]=req.body[f]; });
  saveDB(); res.json(p);
});
app.delete('/api/patients/:id', (req, res) => {
  const idx = db.patients.findIndex(p=>p.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error:'Not found' });
  db.patients.splice(idx,1); saveDB(); res.json({ deleted:true });
});

// ── REMINDERS ─────────────────────────────────────────────────
app.get('/api/reminders', (req, res) => {
  const { patientId } = req.query;
  res.json(patientId ? db.reminders.filter(r=>r.patientId===patientId) : db.reminders);
});
app.post('/api/reminders', (req, res) => {
  const { patientId, type, label, time, days } = req.body;
  if (!patientId||!type||!label||!time) return res.status(400).json({ error:'Missing fields' });
  const r = { id:`R${Date.now()}`, patientId, type, label, time, days:days||['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active:true, createdAt:new Date().toISOString() };
  db.reminders.push(r); saveDB(); res.status(201).json(r);
});
app.patch('/api/reminders/:id', (req, res) => {
  const r = db.reminders.find(r=>r.id===req.params.id);
  if (!r) return res.status(404).json({ error:'Not found' });
  ['type','label','time','days','active'].forEach(f=>{ if(req.body[f]!==undefined) r[f]=req.body[f]; });
  saveDB(); res.json(r);
});
app.delete('/api/reminders/:id', (req, res) => {
  const idx = db.reminders.findIndex(r=>r.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error:'Not found' });
  db.reminders.splice(idx,1); saveDB(); res.json({ deleted:true });
});

// ── ACTIVITY + STATS ──────────────────────────────────────────
app.get('/api/activity', (req, res) => {
  const { patientId, limit } = req.query;
  let logs = patientId ? db.activity.filter(a=>a.patientId===patientId) : db.activity;
  if (limit) logs = logs.slice(0, parseInt(limit));
  res.json(logs);
});
app.post('/api/activity', (req, res) => {
  logActivity(req.body.patientId, req.body.type, req.body.message);
  res.status(201).json({ logged:true });
});
app.get('/api/stats', (req, res) => {
  res.json({
    patients:        db.patients.length,
    activeReminders: db.reminders.filter(r=>r.active).length,
    activityToday:   db.activity.filter(a=>new Date(a.timestamp)>new Date(Date.now()-86400000)).length,
    totalActivity:   db.activity.length
  });
});

// ── CATCH-ALL ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  🧠  CogniCare — Gemini AI');
  console.log(`  ●   http://localhost:${PORT}`);
  console.log(`  🤖  Model: ${GEMINI_MODEL}`);
  console.log(`  🔑  API Key: ${GEMINI_API_KEY ? '✓ Set' : '✗ Missing'}`);
  if (!GEMINI_API_KEY) {
    console.log('');
    console.log('  → Get your FREE key at: aistudio.google.com');
    console.log('  → Set it as: GEMINI_API_KEY=your-key-here');
    console.log('  → Change model with: GEMINI_MODEL=gemini-2.0-flash-exp');
  }
  console.log('');
});
