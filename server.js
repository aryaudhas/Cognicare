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
const fetch = require('node-fetch');

const app  = express();
const PORT               = process.env.PORT || 3000;
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY     || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

// ── OpenRouter config ─────────────────────────────────────────
// Docs: https://openrouter.ai/docs
// Free models: meta-llama/llama-3.1-8b-instruct:free, mistralai/mistral-7b-instruct:free
// Swap OPENROUTER_MODEL to any model slug from openrouter.ai/models
const OPENROUTER_BASE  = 'https://openrouter.ai/api/v1';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';

// Gemini client setup
let genAI = null;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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



// Text gen
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

// Chat with history 
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

// ── OpenRouter (LLM-2 auditor) ────────────────────────────────
async function openRouterText(systemPrompt, userPrompt) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set. Get a free key at openrouter.ai');

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization':  `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type':   'application/json',
      'HTTP-Referer':   'https://cognicare.app',   // shown in OpenRouter dashboard
      'X-Title':        'CogniCare'
    },
    body: JSON.stringify({
      model:      OPENROUTER_MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   }
      ]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
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

// ── AI: DUAL-LLM DAILY SUMMARY ───────────────────────────────
//
//  Flow:
//    1. Pull today's activity log for the patient from db.activity
//    2. LLM-1 (Gemini)      → generate a narrative daily summary
//    3. LLM-2 (OpenRouter)  → fact-check the summary, flag hallucinations,
//                             return corrected summary + audit report
//    4. Respond with all three artefacts so the frontend can show the audit trail
//
app.post('/api/summary/daily', async (req, res) => {
  const { patientId } = req.body;
  const patient = db.patients.find(p => p.id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  // ── build today's activity list from the stored log ──────────
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayLogs = db.activity
    .filter(a => a.patientId === patientId && new Date(a.timestamp) >= todayStart)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Format each entry as "HH:MM — message"
  const logLines = todayLogs.length
    ? todayLogs.map(a => {
        const t = new Date(a.timestamp);
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        return `[${hh}:${mm}] (${a.type}) ${a.message}`;
      }).join('\n')
    : 'No activity recorded today yet.';

  const today = new Date().toLocaleDateString('en-CA', { dateStyle: 'long' });

  try {
    const startTime = Date.now();

    // ── STEP 1: Gemini generates the first-pass summary ────────
    const geminiPrompt = `You are a clinical AI assistant helping caregivers understand a patient's day.

Patient: ${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}
Caregiver: ${patient.caregiver}
Date: ${today}

Today's raw activity log:
${logLines}

Write a concise, empathetic daily summary (3–5 sentences) covering:
• Cognitive engagement (memory, conversations, games)
• Physical activity and mobility
• Mood and emotional state
• Medication / meal adherence
• Any events warranting caregiver attention

Be factual. Only state what is directly supported by the log. Do not invent details.`;

    let geminiSummary;
    try {
      geminiSummary = await geminiText(geminiPrompt);
    } catch (e) {
      return res.status(502).json({ error: `Gemini (LLM-1) failed: ${e.message}` });
    }

    // ── STEP 2: OpenRouter audits the Gemini summary ───────────
    const auditorSystem = `You are a medical AI auditor. Your job is to rigorously fact-check
another AI's summary of a patient's daily activity log.
Respond ONLY with a valid JSON object — no markdown fences, no extra text.`;

    const auditorUser = `Another AI (Gemini) wrote the following daily summary for patient "${patient.name}".
Fact-check it against the raw activity log below.

=== RAW ACTIVITY LOG ===
${logLines}

=== GEMINI SUMMARY TO AUDIT ===
${geminiSummary}

Return this exact JSON schema:
{
  "errors": [
    {
      "claim": "<exact phrase from summary>",
      "issue": "<why unsupported or wrong>",
      "severity": "high | medium | low"
    }
  ],
  "hallucinated_facts": ["<fact invented by Gemini not found in log>"],
  "omitted_important_events": ["<important log entry the summary missed>"],
  "accuracy_score": <integer 0-100>,
  "corrected_summary": "<revised 3-5 sentence summary 100% grounded in the log>"
}

If the summary is fully accurate: empty arrays for errors and hallucinated_facts,
accuracy_score = 100, corrected_summary = the original summary.`;

    let audit;
    try {
      const rawAudit = await openRouterText(auditorSystem, auditorUser);
      // Strip accidental markdown fences
      const clean = rawAudit.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('OpenRouter did not return valid JSON');
      audit = JSON.parse(match[0]);
    } catch (e) {
      // Graceful degradation — return Gemini summary without audit
      audit = {
        errors: [],
        hallucinated_facts: [],
        omitted_important_events: [],
        accuracy_score: null,
        corrected_summary: geminiSummary,
        audit_error: e.message
      };
    }

    // ── STEP 3: pick final summary ──────────────────────────────
    const hasIssues   = audit.errors?.length > 0 || audit.hallucinated_facts?.length > 0;
    const finalSummary = hasIssues
      ? audit.corrected_summary || geminiSummary
      : geminiSummary;

    // Log the summary generation as an activity
    logActivity(patientId, 'summary',
      `Daily summary generated — accuracy ${audit.accuracy_score ?? '?'}% — ${hasIssues ? 'corrections applied' : 'no issues found'}`);

    return res.json({
      patientId,
      patientName:      patient.name,
      date:             today,
      activityCount:    todayLogs.length,
      geminiSummary,
      audit,
      finalSummary,
      corrected:        hasIssues,
      processingMs:     Date.now() - startTime,
      models: {
        generator: 'gemini-1.5-flash',
        auditor:   OPENROUTER_MODEL
      }
    });

  } catch (e) {
    console.error('Daily summary error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CATCH-ALL ─────────────────────────────────────────────────
app.get('*', (req, res) => {
 res.sendFile(path.join(__dirname, 'index.html'));
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  🧠  CogniCare AI Assistant');
  console.log(`  ●   http://localhost:${PORT}`);
  console.log(`  🔑  Gemini API Key:     ${GEMINI_API_KEY     ? '✓ Set' : '✗ Missing — set GEMINI_API_KEY'}`);
  console.log(`  🔑  OpenRouter API Key: ${OPENROUTER_API_KEY ? '✓ Set' : '✗ Missing — set OPENROUTER_API_KEY'}`);
  console.log(`  🤖  Auditor model:      ${OPENROUTER_MODEL}`);
  console.log(`  💡  OpenRouter key:     openrouter.ai/keys`);
  console.log('');
});
