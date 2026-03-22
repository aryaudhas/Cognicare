// ============================================================
//  CogniCare — Express Backend (Google Gemini)
//  AUTO MODEL DETECTION + JSON Analysis + Real-time Alerts
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

// ── SSE: connected caregiver clients ─────────────────────────
// Map of clientId → response object
const sseClients = new Map();

function broadcastAlert(alertData) {
  const payload = JSON.stringify(alertData);
  sseClients.forEach((res) => {
    try { res.write(`data: ${payload}\n\n`); } catch (e) { /* client disconnected */ }
  });
  console.log(`[ALERT] Broadcast to ${sseClients.size} client(s): ${alertData.message}`);
}

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
    ],
    alerts: []  // persistent alert log
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
if (!db.alerts) db.alerts = [];

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Gemini helpers ────────────────────────────────────────────
function requireAI() {
  if (!genAI || !activeModel) throw new Error(!genAI ? 'GEMINI_API_KEY not set. Get free key at aistudio.google.com' : 'No working Gemini model found.');
}
function cleanJSON(text) { return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim(); }

async function tryModels(fn) {
  if (activeModel) {
    try { return await fn(activeModel); }
    catch (e) { if (!e.message.includes('404') && !e.message.includes('429') && !e.message.includes('not found')) throw e; }
  }
  for (const modelId of MODEL_CANDIDATES) {
    if (modelId === activeModel) continue;
    try { const r = await fn(modelId); activeModel = modelId; return r; }
    catch (e) { if (!e.message.includes('404') && !e.message.includes('429') && !e.message.includes('not found')) throw e; }
  }
  throw new Error('No working Gemini model available.');
}

async function geminiText(prompt, sys = '') {
  requireAI();
  return tryModels(async (m) => {
    const model  = genAI.getGenerativeModel({ model:m, ...(sys?{systemInstruction:sys}:{}) });
    const result = await model.generateContent(prompt);
    return result.response.text();
  });
}

async function geminiChat(history, sys = '') {
  requireAI();
  return tryModels(async (m) => {
    const model  = genAI.getGenerativeModel({ model:m, ...(sys?{systemInstruction:sys}:{}) });
    const hist   = history.slice(0,-1).map(h => ({ role: h.role==='assistant'?'model':'user', parts:[{text:h.content}] }));
    const chat   = model.startChat({ history: hist });
    const result = await chat.sendMessage(history[history.length-1].content);
    return result.response.text();
  });
}

async function geminiVision(imageParts, prompt) {
  requireAI();
  return tryModels(async (m) => {
    const model  = genAI.getGenerativeModel({ model:m });
    const result = await model.generateContent([...imageParts, { text:prompt }]);
    return result.response.text();
  });
}

// ── YouTube helpers ───────────────────────────────────────────
function extractYouTubeId(url) {
  const patterns = [/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/, /youtube\.com\/shorts\/([^&\n?#]+)/];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  return null;
}

async function getYouTubeData(videoId) {
  const thumbUrls = [`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`, `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`];
  const images = [];
  for (const url of thumbUrls) {
    try { const res=await fetch(url); if(!res.ok)continue; const buf=await res.buffer(); if(buf.length<5000)continue; images.push({data:buf.toString('base64'),mediaType:'image/jpeg'}); } catch {}
  }
  let metadata = { title:'Unknown', author:'Unknown' };
  try { const r=await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`); if(r.ok){const d=await r.json();metadata.title=d.title||'Unknown';metadata.author=d.author_name||'Unknown';} } catch {}
  return { images, metadata, videoId, videoUrl:`https://www.youtube.com/watch?v=${videoId}` };
}

// ============================================================
//  SSE — Real-time caregiver notifications
// ============================================================

// Caregiver subscribes to live alerts
app.get('/api/alerts/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  sseClients.set(clientId, res);
  console.log(`[SSE] Caregiver connected (${sseClients.size} total)`);

  // Send recent unread alerts immediately on connect
  const recentAlerts = db.alerts.slice(0, 5);
  if (recentAlerts.length) {
    res.write(`data: ${JSON.stringify({ type:'history', alerts: recentAlerts })}\n\n`);
  }

  // Keep-alive ping every 25s (prevents timeout)
  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(keepAlive); }
  }, 25000);

  req.on('close', () => {
    sseClients.delete(clientId);
    clearInterval(keepAlive);
    console.log(`[SSE] Caregiver disconnected (${sseClients.size} total)`);
  });
});

// Patient sends an alert to caregiver
app.post('/api/alerts/send', (req, res) => {
  const { patientId, type, message, severity } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  const patient = db.patients.find(p => p.id === patientId);

  const alert = {
    id:          `ALT${Date.now()}`,
    patientId:   patientId || 'unknown',
    patientName: patient?.name || 'Patient',
    type:        type     || 'help_request',
    message:     message,
    severity:    severity || 'high',
    timestamp:   new Date().toISOString(),
    read:        false
  };

  // Save to DB
  db.alerts.unshift(alert);
  if (db.alerts.length > 100) db.alerts = db.alerts.slice(0, 100);
  saveDB();

  // Log to activity
  logActivity(patientId || 'unknown', 'patient_alert', `🚨 ${alert.patientName}: ${message}`);

  // Broadcast to all connected caregiver dashboards
  broadcastAlert({ type: 'new_alert', alert });

  res.status(201).json({ success: true, alert });
});

// Get alert history
app.get('/api/alerts', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(db.alerts.slice(0, limit));
});

// Mark alert as read
app.patch('/api/alerts/:id/read', (req, res) => {
  const alert = db.alerts.find(a => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'Not found' });
  alert.read = true;
  saveDB();
  res.json({ success: true });
});

// Clear all alerts
app.delete('/api/alerts', (req, res) => {
  db.alerts = [];
  saveDB();
  res.json({ success: true });
});

// ── API: AI STATUS ────────────────────────────────────────────
app.get('/api/ai-status', (req, res) => {
  res.json({ hasKey:!!genAI, activeModel:activeModel||'none', ready:!!(genAI&&activeModel), status:genAI&&activeModel?`✓ Ready — ${activeModel}`:!genAI?'✗ No API key':'✗ No working model' });
});

// ── API: YOUTUBE INFO ─────────────────────────────────────────
app.post('/api/youtube-info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error:'URL required' });
  const videoId = extractYouTubeId(url);
  if (!videoId) return res.status(400).json({ error:'Invalid YouTube URL' });
  try { const data=await getYouTubeData(videoId); res.json({ success:true, ...data }); }
  catch (e) { res.status(500).json({ error:e.message }); }
});

// ── API: ANALYZE ──────────────────────────────────────────────
// ── SAFETY RULES — what to detect and what to do ─────────────
const SAFETY_RULES = [
  {
    id: 'stove',
    keywords: ['stove','oven','burner','cooktop','gas','flame','cooking','hob'],
    patientReminder: 'Please remember to turn off the stove when you are done cooking. Safety first! 🔥',
    caregiverAlert:  'Patient appears to be using the stove. Please monitor and ensure it is turned off after use.',
    severity: 'high',
    tip: 'Turn off the stove when done'
  },
  {
    id: 'knife',
    keywords: ['knife','knives','blade','chopping','cutting','scissors','sharp'],
    patientReminder: 'Please be very careful with sharp objects. Take your time and stay safe. 🔪',
    caregiverAlert:  'Patient appears to be handling a knife or sharp object. Please supervise.',
    severity: 'high',
    tip: 'Be careful with sharp objects'
  },
  {
    id: 'stairs',
    keywords: ['stairs','staircase','steps','ladder','climbing','descending'],
    patientReminder: 'Please hold the handrail tightly when going up or down the stairs. Take it slowly. 🪜',
    caregiverAlert:  'Patient is near stairs. Fall risk — please ensure they use the handrail.',
    severity: 'medium',
    tip: 'Hold handrail on stairs'
  },
  {
    id: 'medication',
    keywords: ['pill','pills','medication','medicine','bottle','tablets','capsules','drugs'],
    patientReminder: 'If those are your medications, only take the ones your caregiver has prepared for you. 💊',
    caregiverAlert:  'Patient appears to be handling medications. Please verify they are taking the correct dose.',
    severity: 'high',
    tip: 'Medication supervision needed'
  },
  {
    id: 'water',
    keywords: ['tap','faucet','running water','sink','bath','bathtub','shower','flooding'],
    patientReminder: 'Please remember to turn off the tap when you are finished. 🚿',
    caregiverAlert:  'Patient is using water fixtures. Please check taps are turned off properly.',
    severity: 'medium',
    tip: 'Turn off taps when done'
  },
  {
    id: 'door',
    keywords: ['door','front door','exit','outside','leaving','wandering','gate'],
    patientReminder: 'Please stay inside where it is safe and warm. Your caregiver will be with you soon. 🚪',
    caregiverAlert:  'Patient appears to be near an exit door. Wandering risk — please check on them immediately.',
    severity: 'critical',
    tip: 'Wandering risk — near exit'
  },
  {
    id: 'fall_risk',
    keywords: ['wet floor','slippery','standing on chair','unstable','no shoes','socks only','rug'],
    patientReminder: 'Please be careful — the floor may be slippery. Hold on to something steady. 🛑',
    caregiverAlert:  'Potential fall hazard detected in the environment. Please check and make area safe.',
    severity: 'high',
    tip: 'Fall hazard detected'
  },
  {
    id: 'iron',
    keywords: ['iron','ironing','ironing board','steam iron'],
    patientReminder: 'Please remember to turn off the iron when you are finished. It can get very hot! 👕',
    caregiverAlert:  'Patient is using an iron. Please ensure it is unplugged after use.',
    severity: 'high',
    tip: 'Turn off iron when done'
  },
  {
    id: 'kettle',
    keywords: ['kettle','boiling water','hot water','steam','tea'],
    patientReminder: 'Be careful — the kettle and water are very hot. Pour slowly and carefully. ☕',
    caregiverAlert:  'Patient is using a kettle with boiling water. Please monitor for burn risk.',
    severity: 'medium',
    tip: 'Hot water burn risk'
  },
  {
    id: 'alone_outside',
    keywords: ['outside alone','garden alone','yard alone','street','road','traffic','alone outdoors'],
    patientReminder: 'Please stay close to home. If you want to go outside, let your caregiver know first. 🏡',
    caregiverAlert:  'Patient appears to be outside or in the garden alone. Please check on them.',
    severity: 'high',
    tip: 'Patient outside alone'
  },
  {
    id: 'electrical',
    keywords: ['electrical','socket','plug','wire','cables','extension cord','exposed wire'],
    patientReminder: 'Please do not touch electrical sockets or wires. Ask your caregiver for help. ⚡',
    caregiverAlert:  'Patient is near electrical hazards. Please supervise and make area safe.',
    severity: 'critical',
    tip: 'Electrical hazard nearby'
  },
  {
    id: 'cleaning',
    keywords: ['cleaning products','bleach','chemicals','spray bottle','detergent','poison'],
    patientReminder: 'Please do not touch cleaning products — they can be harmful. Ask your caregiver for help. 🧴',
    caregiverAlert:  'Patient is handling cleaning products or chemicals. Please supervise immediately.',
    severity: 'critical',
    tip: 'Hazardous chemicals in use'
  }
];

app.post('/api/analyze', async (req, res) => {
  const { images, patientId, patientName, context, youtubeUrl } = req.body;
  let imagesToAnalyze = images || [], videoContext = context || '';
  if (youtubeUrl) {
    try {
      const videoId=extractYouTubeId(youtubeUrl); if(!videoId) return res.status(400).json({error:'Invalid YouTube URL'});
      const ytData=await getYouTubeData(videoId); imagesToAnalyze=[...imagesToAnalyze,...ytData.images]; videoContext=`YouTube: "${ytData.metadata.title}" by ${ytData.metadata.author}. ${context||''}`;
    } catch(e) { return res.status(500).json({error:`YouTube failed: ${e.message}`}); }
  }
  if (!imagesToAnalyze.length) return res.status(400).json({ error:'No images provided' });
  try {
    const patient = db.patients.find(p=>p.id===patientId);
    const name    = patientName || patient?.name || 'the patient';
    const imageParts = imagesToAnalyze.slice(0,4).map(img=>({inlineData:{data:img.data,mimeType:img.mediaType||'image/jpeg'}}));

    const prompt = `You are a compassionate AI medical assistant for cognitive decline monitoring.
Analyze this image/video of ${name} carefully.

Patient: ${patient?`${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}, Notes: ${patient.notes}`:'Unknown'}
${videoContext?`Context: ${videoContext}`:''}

IMPORTANT — also look specifically for ANY of these safety hazards:
- Stove, oven, cooktop, flame, or cooking in progress
- Knife, scissors, or sharp objects being handled
- Stairs, ladder, or climbing
- Medications or pill bottles
- Running taps, bath, shower, or flooding risk
- Front door, exit, or signs of wandering
- Wet/slippery floor, unstable surfaces, no footwear
- Iron or ironing board in use
- Kettle or boiling water
- Electrical sockets, exposed wires
- Cleaning chemicals, bleach, spray bottles
- Being outside or in garden alone

Return ONLY this JSON no markdown:
{
  "observations": [],
  "cognitiveIndicators": {
    "confusion": "none|mild|moderate|severe",
    "agitation": "none|mild|moderate|severe",
    "disorientation": "none|mild|moderate|severe",
    "expressionConcern": "none|mild|moderate|severe"
  },
  "physicalIndicators": {
    "posture": "",
    "mobility": "",
    "grooming": "",
    "fatigue": "none|mild|moderate|severe"
  },
  "immediateNeeds": [],
  "recommendations": [],
  "urgency": "routine|attention|urgent",
  "summary": "",
  "safetyFlags": [],
  "hazardsDetected": [
    {
      "hazard": "name of hazard detected e.g. stove, knife, stairs",
      "description": "what exactly you see",
      "riskLevel": "low|medium|high|critical",
      "patientMessage": "A short warm gentle reminder message TO the patient about this hazard (max 2 sentences)",
      "caregiverMessage": "A clear alert message FOR the caregiver about what was detected"
    }
  ]
}

If no hazards detected, hazardsDetected must be an empty array [].
Be thorough — patient safety is the priority.`;

    const raw     = await geminiVision(imageParts, prompt);
    const clean   = cleanJSON(raw);
    const match   = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI did not return valid JSON');
    const analysis = JSON.parse(match[0]);

    // ── AUTO-SEND ALERTS FOR DETECTED HAZARDS ────────────────
    const hazards = analysis.hazardsDetected || [];
    const autoAlerts = [];

    for (const hazard of hazards) {
      if (!hazard.hazard) continue;

      // Match against our safety rules for richer messages
      const rule = SAFETY_RULES.find(r =>
        r.keywords.some(k => hazard.hazard.toLowerCase().includes(k) || (hazard.description||'').toLowerCase().includes(k))
      );

      const alertMsg = rule
        ? rule.caregiverAlert
        : (hazard.caregiverMessage || `Hazard detected: ${hazard.hazard} — ${hazard.description}`);

      const severity = hazard.riskLevel === 'critical' ? 'urgent'
        : hazard.riskLevel === 'high' ? 'high'
        : hazard.riskLevel === 'medium' ? 'medium' : 'low';

      // Create caregiver alert
      const alert = {
        id:          `ALT${Date.now()}${Math.random().toString(36).slice(2)}`,
        patientId:   patientId || 'unknown',
        patientName: patient?.name || 'Patient',
        type:        'safety_hazard',
        message:     `⚠️ Safety: ${alertMsg}`,
        severity,
        timestamp:   new Date().toISOString(),
        read:        false
      };
      db.alerts.unshift(alert);
      broadcastAlert({ type: 'new_alert', alert });
      autoAlerts.push(alert);

      // Add patient reminder message to hazard (use rule message if available)
      if (rule) hazard.patientMessage = rule.patientReminder;
    }

    if (autoAlerts.length) saveDB();

    logActivity(
      patientId||'unknown', 'analysis',
      `Analysis (${youtubeUrl?'YouTube':'image'}): ${analysis.urgency}${hazards.length ? ` — ⚠️ ${hazards.length} hazard(s): ${hazards.map(h=>h.hazard).join(', ')}` : ' — no hazards'}`
    );

    res.json({ success:true, analysis, modelUsed:activeModel, autoAlertsSent:autoAlerts.length });
  } catch(e) { console.error('Analysis error:',e.message); res.status(500).json({error:e.message}); }
});

// ── API: CHAT ─────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, patientId, mode } = req.body;
  if (!messages?.length) return res.status(400).json({ error:'No messages' });
  try {
    const patient=db.patients.find(p=>p.id===patientId), reminders=db.reminders.filter(r=>r.patientId===patientId&&r.active);
    const sys = mode==='patient'
      ? `You are a warm gentle AI companion for ${patient?.name||'a person'} who has cognitive decline. Simple short sentences max 3. Warm and reassuring. Gently orient if confused. If pain/fall/distress say press red emergency button. Use first name often.\nPatient: ${patient?`${patient.name}, Age ${patient.age}, Stage: ${patient.stage}`:'Unknown'}\nReminders: ${reminders.map(r=>`${r.time} — ${r.label}`).join(', ')||'None'}`
      : `You are an expert AI assistant for caregivers managing cognitive decline patients. Help with behavioral changes, care strategies, communication, agitation, sundowning, burnout, disease stages, safety. Always recommend consulting medical professionals.\nPatient: ${patient?`${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}. Notes: ${patient.notes}`:'Not specified'}`;
    const response=await geminiChat(messages,sys);
    logActivity(patientId||'unknown','chat',`${mode==='patient'?'Patient':'Caregiver'} used AI assistant`);
    res.json({ success:true, response, modelUsed:activeModel });
  } catch(e) { console.error('Chat error:',e.message); res.status(500).json({error:e.message}); }
});

// ── API: SUGGEST REMINDERS ────────────────────────────────────
app.post('/api/suggest-reminders', async (req, res) => {
  const { patientId }=req.body, patient=db.patients.find(p=>p.id===patientId);
  if (!patient) return res.status(404).json({ error:'Patient not found' });
  try {
    const raw=await geminiText(`Generate daily reminder schedule for: Name: ${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}, Notes: ${patient.notes}\nReturn ONLY JSON array with: type(meal|medication|bathroom|hydration|activity|social|sleep|grooming), label, time(HH:MM), days array. 8-12 reminders. No markdown.`);
    const clean=cleanJSON(raw), match=clean.match(/\[[\s\S]*\]/);
    if(!match) throw new Error('Could not parse suggestions');
    res.json({ success:true, suggestions:JSON.parse(match[0]), modelUsed:activeModel });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── API: JSON ANALYZE ─────────────────────────────────────────
app.post('/api/json-analyze', async (req, res) => {
  const { jsonData, patientId, dataType, date }=req.body;
  if (!jsonData) return res.status(400).json({ error:'No JSON data provided' });
  let parsedData;
  try { parsedData = typeof jsonData==='string' ? JSON.parse(jsonData) : jsonData; }
  catch(e) { return res.status(400).json({ error:`Invalid JSON: ${e.message}` }); }
  try {
    const patient=db.patients.find(p=>p.id===patientId);
    const prompt=`You are a compassionate AI medical assistant for cognitive decline monitoring.
Patient: ${patient?`${patient.name}, Age: ${patient.age}, Stage: ${patient.stage}. Notes: ${patient.notes}`:'Unknown'}
Data type: ${dataType||'General health data'}, Date: ${date||new Date().toLocaleDateString('en-CA')}
JSON data: ${JSON.stringify(parsedData,null,2)}

Return ONLY this JSON no markdown:
{"dailySummary":{"overview":"2-3 sentence overview","overallStatus":"good|fair|concerning|critical","keyFindings":[],"positives":[],"concerns":[]},"alerts":[{"priority":"low|medium|high|critical","category":"medication|nutrition|hydration|mobility|cognitive|safety|social|sleep|other","title":"","description":"","action":""}],"recommendations":[{"timeframe":"immediate|today|this_week","text":""}],"metricsExtracted":{},"nextCheckIn":""}
Sort alerts by priority. Be thorough and compassionate.`;
    const raw=await geminiText(prompt), clean=cleanJSON(raw), match=clean.match(/\{[\s\S]*\}/);
    if(!match) throw new Error('AI did not return valid JSON');
    const result=JSON.parse(match[0]);
    const alertCount=result.alerts?.length||0, highAlerts=result.alerts?.filter(a=>a.priority==='high'||a.priority==='critical').length||0;
    logActivity(patientId||'unknown','json_analysis',`JSON analysis: ${result.dailySummary?.overallStatus||'unknown'} — ${alertCount} alerts (${highAlerts} high/critical)`);

    // Auto-broadcast critical alerts to caregiver
    if (highAlerts > 0) {
      const patient = db.patients.find(p => p.id === patientId);
      result.alerts.filter(a => a.priority === 'high' || a.priority === 'critical').forEach(a => {
        const sysAlert = {
          id:          `ALT${Date.now()}${Math.random()}`,
          patientId:   patientId || 'unknown',
          patientName: patient?.name || 'Patient',
          type:        'json_alert',
          message:     `${a.title} — ${a.description.slice(0, 100)}`,
          severity:    a.priority,
          timestamp:   new Date().toISOString(),
          read:        false
        };
        db.alerts.unshift(sysAlert);
        broadcastAlert({ type: 'new_alert', alert: sysAlert });
      });
      saveDB();
    }

    res.json({ success:true, result, modelUsed:activeModel });
  } catch(e) { console.error('JSON analyze error:',e.message); res.status(500).json({error:e.message}); }
});

// ── PATIENTS ──────────────────────────────────────────────────
app.get('/api/patients',     (req,res)=>res.json(db.patients));
app.get('/api/patients/:id', (req,res)=>{ const p=db.patients.find(p=>p.id===req.params.id); if(!p)return res.status(404).json({error:'Not found'}); res.json(p); });
app.post('/api/patients', (req,res)=>{ const{name,age,stage,caregiver,phone,notes}=req.body; if(!name)return res.status(400).json({error:'Name required'}); const p={id:`P${Date.now()}`,name,age:age||'',stage:stage||'Mild',caregiver:caregiver||'',phone:phone||'',notes:notes||'',createdAt:new Date().toISOString()}; db.patients.push(p);saveDB();res.status(201).json(p); });
app.patch('/api/patients/:id', (req,res)=>{ const p=db.patients.find(p=>p.id===req.params.id); if(!p)return res.status(404).json({error:'Not found'}); ['name','age','stage','caregiver','phone','notes'].forEach(f=>{if(req.body[f]!==undefined)p[f]=req.body[f];}); saveDB();res.json(p); });
app.delete('/api/patients/:id', (req,res)=>{ const idx=db.patients.findIndex(p=>p.id===req.params.id); if(idx===-1)return res.status(404).json({error:'Not found'}); db.patients.splice(idx,1);saveDB();res.json({deleted:true}); });

// ── REMINDERS ─────────────────────────────────────────────────
app.get('/api/reminders', (req,res)=>{ const{patientId}=req.query; res.json(patientId?db.reminders.filter(r=>r.patientId===patientId):db.reminders); });
app.post('/api/reminders', (req,res)=>{ const{patientId,type,label,time,days}=req.body; if(!patientId||!type||!label||!time)return res.status(400).json({error:'Missing fields'}); const r={id:`R${Date.now()}`,patientId,type,label,time,days:days||['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],active:true,createdAt:new Date().toISOString()}; db.reminders.push(r);saveDB();res.status(201).json(r); });
app.patch('/api/reminders/:id', (req,res)=>{ const r=db.reminders.find(r=>r.id===req.params.id); if(!r)return res.status(404).json({error:'Not found'}); ['type','label','time','days','active'].forEach(f=>{if(req.body[f]!==undefined)r[f]=req.body[f];}); saveDB();res.json(r); });
app.delete('/api/reminders/:id', (req,res)=>{ const idx=db.reminders.findIndex(r=>r.id===req.params.id); if(idx===-1)return res.status(404).json({error:'Not found'}); db.reminders.splice(idx,1);saveDB();res.json({deleted:true}); });

// ── ACTIVITY + STATS ──────────────────────────────────────────
app.get('/api/activity', (req,res)=>{ const{patientId,limit}=req.query; let logs=patientId?db.activity.filter(a=>a.patientId===patientId):db.activity; if(limit)logs=logs.slice(0,parseInt(limit)); res.json(logs); });
app.post('/api/activity', (req,res)=>{ logActivity(req.body.patientId,req.body.type,req.body.message); res.status(201).json({logged:true}); });
app.get('/api/stats', (req,res)=>{ res.json({ patients:db.patients.length, activeReminders:db.reminders.filter(r=>r.active).length, activityToday:db.activity.filter(a=>new Date(a.timestamp)>new Date(Date.now()-86400000)).length, totalActivity:db.activity.length, unreadAlerts:db.alerts.filter(a=>!a.read).length }); });

// ── CATCH-ALL ─────────────────────────────────────────────────
app.get('*', (req,res)=>{ res.sendFile(path.join(__dirname,'public','index.html')); });

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
    else console.log('  ⚠   No working model found.');
  }
  console.log('');
});
