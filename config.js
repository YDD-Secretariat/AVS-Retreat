// ------------------------------------------------------------------
// Paste your deployed Apps Script Web App URL here (ends in /exec).
// ------------------------------------------------------------------
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwl_F2578W7aFxNS3Npe55Fd7ogmZZ6l4pUje_Lwo1IZNkhCdfXA0_h6xIV2FFFnudz/exec";

const AVS = {
  async get(action, params) {
    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set("action", action);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    return res.json();
  },
  // Sent as text/plain to avoid a CORS preflight (Apps Script parses it as JSON server-side).
  async post(body) {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    });
    return res.json();
  },
  getStation() {
    return localStorage.getItem("avs_station") || "";
  },
  setStation(name) {
    localStorage.setItem("avs_station", name);
  }
};
