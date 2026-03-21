// ============================================================
//  CogniCare — Express Backend (Gemini API)
//  Set GEMINI_API_KEY in your environment / Railway variables
//  Free tier: 15 requests/min, 1500 requests/day
//  Get your free key at: aistudio.google.com
// ============================================================

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Gemini client setup
let genAI = null;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// ── DB helpers ────────────────────────────────────────────────
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { console.warn('DB read error, using defaults'); }
  return {
    patients: [
      {
        id: 'P001', name: 'Margaret Thompson', age: 78, stage: 'Moderate',
        caregiver: 'Susan Thompson', phone: '(416) 555-0123',
        notes: 'Former schoolteacher. Enjoys classical music and gardening. Has trouble remembering recent events but long-term memory intact.',
        createdAt: new Date().toISOString()
      }
    ],
    reminders: [
      { id: 'R001', patientId: 'P001', type: 'meal',       label: 'Breakfast',           time: '08:00', days: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active: true, createdAt: new Date().toISOString() },
      { id: 'R002', patientId: 'P001', type: 'medication', label: 'Morning medication',   time: '09:00', days: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active: true, createdAt: new Date().toISOString() },
      { id: 'R003', patientId: 'P001', type: 'meal',       label: 'Lunch',                time: '12:30', days: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active: true, createdAt: new Date().toISOString() },
      { id: 'R004', patientId: 'P001', type: 'bathroom',   label: 'Bathroom break',       time: '14:00', days: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active: true, createdAt: new Date().toISOString() },
      { id: 'R005', patientId: 'P001', type: 'medication', label: 'Afternoon medication', time: '15:00', days: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active: true, createdAt: new Date().toISOString() },
      { id: 'R006', patientId: 'P001', type: 'meal',       label: 'Dinner',               time: '18:00', days: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active: true, createdAt: new Date().toISOString() },
      { id: 'R007', patientId: 'P001', type: 'hydration',  label: 'Drink water',          time: '10:00', days: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], active: true, createdAt: new Date().toISOString() },
      { id: 'R008', patientId: 'P001', type: 'activity',   label: 'Short walk outside',   time: '11:00', days: ['Mon','Wed','Fri'],                        active: true, createdAt: new Date().toISOString() },
    ],
    activity: [
      { id: 'A001', patientId: 'P001', type: 'reminder_sent', message: 'Breakfast reminder sent',                              timestamp: new Date(Date.now() - 3600000*2).toISOString() },
      { id: 'A002', patientId: 'P001', type: 'analysis',      message: 'Image analysis completed — no concerning signs observed', timestamp: new Date(Date.now() - 3600000*5).toISOString() },
      { id: 'A003', patientId: 'P001', type: 'chat',          message: 'Patient used AI assistant',                            timestamp: new Date(Date.now() - 3600000*8).toISOString() },
    ]
  };
}

function saveDB() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function logActivity(patientId, type, message) {
  db.activity.unshift({
    id: `A${Date.now()}`, patientId, type, message,
    timestamp: new Date().toISOString()
  });
  if (db.activity.length > 200) db.activity = db.activity.slice(0, 200);
  saveDB();
}

let db = loadDB();

// ── Gemini helpers ────────────────────────────────────────────

// Simple text generation (for chat and suggestions)
async function geminiText(prompt, systemInstruction = '') {
  if (!genAI) throw new Error('GEMINI_API_KEY not set. Get your free key at aistudio.google.com');

  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: systemInstruction || undefined,
  });

  const result   = await model.generateContent(prompt);
  const response = await result.response;
  return response.text();
}

// Chat with history (for multi-turn conversation)
async function geminiChat(history, systemInstruction = '') {
  if (!genAI) throw new Error('GEMINI_API_KEY not set. Get your free key at aistudio.google.com');

  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: systemInstruction || undefined,
  });

  // Convert our {role, content} format to Gemini format
  // Gemini uses 'user' and 'model' roles
  const geminiHistory = history.slice(0, -1).map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const lastMessage = history[history.length - 1].content;

  const chat   = model.startChat({ history: geminiHistory });
  const result = await chat.sendMessage(lastMessage);
  return result.response.text();
}

// Image analysis (multimodal)
async function geminiAnalyzeImages(imageParts, prompt) {
  if (!genAI) throw new Error('GEMINI_API_KEY not set. Get your free key at aistudio.google.com');

  // gemini-1.5-flash supports vision
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const parts = [
    ...imageParts,   // { inlineData: { data, mimeType } }
    { text: prompt }
  ];

  const result   = await model.generateContent(parts);
  const response = await result.response;
  return response.text();
}

// ── PATIENTS ──────────────────────────────────────────────────
app.get('/api/patients', (req, res) => res.json(db.patients));

app.get('/api/patients/:id', (req, res) => {
  const p = db.patients.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Patient not found' });
  res.json(p);
});

app.post('/api/patients', (req, res) => {
  const { name, age, stage, caregiver, phone, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const patient = {
    id: `P${Date.now()}`, name, age: age||'', stage: stage||'Mild',
    caregiver: caregiver||'', phone: phone||'', notes: notes||'',
    createdAt: new Date().toISOString()
  };
  db.patients.push(patient);
  saveDB();
  res.status(201).json(patient);
});

app.patch('/api/patients/:id', (req, res) => {
  const p = db.patients.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Patient not found' });
  ['name','age','stage','caregiver','phone','notes'].forEach(f => {
    if (req.body[f] !== undefined) p[f] = req.body[f];
  });
  saveDB();
  res.json(p);
});

app.delete('/api/patients/:id', (req, res) => {
  const idx = db.patients.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.patients.splice(idx, 1);
  saveDB();
  res.json({ deleted: true });
});

// ── REMINDERS ─────────────────────────────────────────────────
app.get('/api/reminders', (req, res) => {
  const { patientId } = req.query;
  res.json(patientId ? db.reminders.filter(r => r.patientId === patientId) : db.reminders);
});

app.post('/api/reminders', (req, res) => {
  const { patientId, type, label, time, days } = req.body;
  if (!patientId || !type || !label || !time) return res.status(400).json({ error: 'Missing fields' });
  const reminder = {
    id: `R${Date.now()}`, patientId, type, label, time,
    days: days || ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
    active: true, createdAt: new Date().toISOString()
  };
  db.reminders.push(reminder);
  saveDB();
  res.status(201).json(reminder);
});

app.patch('/api/reminders/:id', (req, res) => {
  const r = db.reminders.find(r => r.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  ['type','label','time','days','active'].forEach(f => {
    if (req.body[f] !== undefined) r[f] = req.body[f];
  });
  saveDB();
  res.json(r);
});

app.delete('/api/reminders/:id', (req, res) => {
  const idx = db.reminders.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.reminders.splice(idx, 1);
  saveDB();
  res.json({ deleted: true });
});

// ── ACTIVITY LOG ──────────────────────────────────────────────
app.get('/api/activity', (req, res) => {
  const { patientId, limit } = req.query;
  let logs = patientId ? db.activity.filter(a => a.patientId === patientId) : db.activity;
  if (limit) logs = logs.slice(0, parseInt(limit));
  res.json(logs);
});

app.post('/api/activity', (req, res) => {
  const { patientId, type, message } = req.body;
  logActivity(patientId, type, message);
  res.status(201).json({ logged: true });
});

// ── STATS ─────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const remindersToday = db.reminders.filter(r => r.active).length;
  const recentActivity = db.activity.filter(a => {
    return new Date(a.timestamp) > new Date(Date.now() - 86400000);
  }).length;
  res.json({
    patients:        db.patients.length,
    activeReminders: remindersToday,
    activityToday:   recentActivity,
    totalActivity:   db.activity.length
  });
});

// ── AI: ANALYZE IMAGE ─────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { images, patientId, patientName, context } = req.body;
  if (!images || !images.length) return res.status(400).json({ error: 'No images provided' });

  try {
    const patient = db.patients.find(p => p.id === patientId);
    const name    = patientName || patient?.name || 'the patient';

    // Build Gemini image parts
    const imageParts = images.slice(0, 4).map(img => ({
      inlineData: {
        data:     img.data,
        mimeType: img.mediaType || 'image/jpeg'
      }
    }));

    const prompt = `You are a compassionate AI assistant helping caregivers monitor cognitive decline in elderly patients.
Analyze this image/these frames of ${name} and provide a structured JSON response with the following fields:

{
  "observations": [list of specific behavioral or physical observations],
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
  "immediateNeeds": [list of things the person may need right now],
  "recommendations": [list of caregiver recommendations],
  "urgency": "routine|attention|urgent",
  "summary": "A warm, human-readable paragraph summarizing the analysis",
  "safetyFlags": [any safety concerns — empty array if none]
}

${context ? `Additional context from caregiver: ${context}` : ''}

Respond ONLY with valid JSON. No markdown code blocks, no extra text. Be compassionate and err on the side of care.`;

    const rawResponse = await geminiAnalyzeImages(imageParts, prompt);

    // Strip markdown code blocks if Gemini wraps in ```json
    const clean     = rawResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse AI response');
    const analysis  = JSON.parse(jsonMatch[0]);

    logActivity(patientId || 'unknown', 'analysis',
      `Image analysis: ${analysis.urgency} — ${(analysis.summary||'').slice(0,80)}...`);

    res.json({ success: true, analysis, raw: rawResponse });

  } catch (e) {
    console.error('Analysis error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AI: CHAT ──────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, patientId, mode } = req.body;
  if (!messages || !messages.length) return res.status(400).json({ error: 'No messages' });

  try {
    const patient   = db.patients.find(p => p.id === patientId);
    const reminders = db.reminders.filter(r => r.patientId === patientId && r.active);

    let systemInstruction = '';

    if (mode === 'patient') {
      systemInstruction = `You are a warm, gentle, patient AI companion for ${patient?.name || 'a person'} who has cognitive decline.
Your role:
- Speak in SIMPLE, SHORT sentences. Never use complex words.
- Be extremely warm, reassuring, and positive. Never make them feel bad.
- If they seem confused, gently orient them (day, time, where they are).
- Remind them of upcoming activities if relevant.
- If they mention pain, distress, or a fall, tell them to call their caregiver immediately.
- Never argue or correct harshly — redirect gently.
- Use their first name often. Keep responses under 3 sentences unless asked a question.
Patient info: ${patient ? `Name: ${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}` : 'Unknown'}
Today's reminders: ${reminders.map(r => `${r.time} - ${r.label}`).join(', ') || 'None set'}`;
    } else {
      systemInstruction = `You are an expert AI assistant for caregivers managing cognitive decline patients.
You help with:
- Interpreting behavioral changes and what they might mean
- Suggesting care strategies and communication techniques  
- Explaining medication effects (always recommend consulting a doctor)
- Providing emotional support for caregiver burnout
- Answering questions about dementia stages and progression
- Recommending activities for cognitive stimulation
Patient being cared for: ${patient ? `${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}. Notes: ${patient.notes}` : 'Not specified'}
Always be evidence-based, compassionate, and remind caregivers to consult medical professionals for medical decisions.`;
    }

    const response = await geminiChat(messages, systemInstruction);

    logActivity(patientId || 'unknown', 'chat',
      `${mode === 'patient' ? 'Patient' : 'Caregiver'} used AI assistant`);

    res.json({ success: true, response });

  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AI: SUGGEST REMINDERS ─────────────────────────────────────
app.post('/api/suggest-reminders', async (req, res) => {
  const { patientId } = req.body;
  const patient = db.patients.find(p => p.id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  try {
    const prompt = `Generate a personalized daily reminder schedule for a cognitive decline patient:
Name: ${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}
Notes: ${patient.notes}

Return a JSON array of reminder objects. Each object must have:
- type: one of: meal, medication, bathroom, hydration, activity, social, sleep, grooming
- label: short friendly description
- time: in HH:MM format (24hr)
- days: array of day abbreviations like ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]

Include 8-12 reminders spread across the day.
Respond with a JSON array ONLY. No markdown, no extra text.`;

    const rawResponse = await geminiText(prompt);
    const clean       = rawResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch   = clean.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Could not parse suggestions');
    const suggestions = JSON.parse(jsonMatch[0]);
    res.json({ success: true, suggestions });
  } catch (e) {
    console.error('Suggest error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CATCH-ALL ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  🧠  CogniCare AI Assistant (Gemini)');
  console.log(`  ●   http://localhost:${PORT}`);
  console.log(`  🔑  Gemini API Key: ${GEMINI_API_KEY ? '✓ Set' : '✗ Missing — set GEMINI_API_KEY'}`);
  console.log(`  💡  Get your FREE key at: aistudio.google.com`);
  console.log('');
});



