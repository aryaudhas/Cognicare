// config.js — same-origin API calls work on both localhost and Railway
const API_BASE = '';
async function apiFetch(path, options) {
  return fetch(API_BASE + path, options);
}
