'use strict';

// DEBUG BUILD — tries V1 (Keycloak) then V2 (Azure B2C), logs everything

const BASE_URL_V1  = 'https://smarthome.wattselectronics.com';
const TOKEN_URL_V1 = 'https://auth.smarthome.wattselectronics.com/realms/watts/protocol/openid-connect/token';
const CLIENT_ID_V1 = 'app-front';

// Azure B2C — Vision+ new platform
const B2C_TENANT   = 'visionlogin.onmicrosoft.com';
const B2C_POLICY   = 'B2C_1A_VISION_UNIFIEDSIGNUPORSIGNIN';
const TOKEN_URL_V2 = `https://visionlogin.b2clogin.com/${B2C_TENANT}/${B2C_POLICY}/oauth2/v2.0/token`;
const BASE_URL_V2  = 'https://prod-vision.watts.io';
// Try both known client IDs — we'll see which one the server accepts
const CLIENT_ID_V2 = 'app-front';
const SCOPE_V2     = `openid offline_access https://visionlogin.onmicrosoft.com/homeassistant-api/homeassistant.read`;

function celsiusToWatts(c) { return Math.round((parseFloat(c) * 1.8 + 32) * 10); }
function wattsTocelsius(w) { return Math.round(((parseFloat(w) / 10 - 32) / 1.8) * 10) / 10; }

const GV_MODE        = { COMFORT: '0', PROGRAM: '1', ECO: '2', OFF: '3', BOOST: '4' };
const GV_MODE_LABELS = { '0': 'comfort', '1': 'program', '2': 'eco', '3': 'off', '4': 'boost', '11': 'eco' };

class WattsApi {
  constructor(log, error) {
    this.log   = log   || console.log;
    this.error = error || console.error;
    this._username         = null;
    this._password         = null;
    this._apiVersion       = null;
    this._accessToken      = null;
    this._refreshToken     = null;
    this._tokenExpiresAt   = null;
    this._refreshExpiresAt = null;
    this._refreshing       = null;
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  async authenticate(username, password) {
    this._username = username;
    this._password = password;

    // ── Try V1 ──
    this.log('[WattsApi] Trying V1 (Keycloak):', TOKEN_URL_V1);
    try {
      await this._fetchTokenV1();
      this._apiVersion = 'v1';
      this.log('[WattsApi] V1 auth SUCCESS — using old platform');
      return true;
    } catch (e1) {
      this.log('[WattsApi] V1 FAILED:', e1.message);
    }

    // ── Try V2 ──
    this.log('[WattsApi] Trying V2 (Azure B2C):', TOKEN_URL_V2);
    try {
      await this._fetchTokenV2();
      this._apiVersion = 'v2';
      this.log('[WattsApi] V2 auth SUCCESS — using new platform');
      return true;
    } catch (e2) {
      this.log('[WattsApi] V2 FAILED:', e2.message);
      throw new Error(
        'Login failed on both platforms.\n' +
        'Old platform: ' + this._v1Error + '\n' +
        'New platform: ' + e2.message
      );
    }
  }

  async _fetchTokenV1() {
    const res = await fetch(TOKEN_URL_V1, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID_V1, grant_type: 'password',
        username: this._username, password: this._password,
      }).toString(),
    });
    const text = await res.text();
    this.log('[WattsApi] V1 response', res.status, ':', text.substring(0, 200));
    if (!res.ok) {
      this._v1Error = 'HTTP ' + res.status + ': ' + text;
      throw new Error(this._v1Error);
    }
    this._storeTokens(JSON.parse(text));
  }

  async _fetchTokenV2() {
    const res = await fetch(TOKEN_URL_V2, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID_V2, grant_type: 'password',
        username: this._username, password: this._password,
        scope: SCOPE_V2,
      }).toString(),
    });
    const text = await res.text();
    this.log('[WattsApi] V2 response', res.status, ':', text.substring(0, 300));
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text);
    this._storeTokens(JSON.parse(text));
  }

  async _doRefresh() {
    const isV2  = this._apiVersion === 'v2';
    const url   = isV2 ? TOKEN_URL_V2 : TOKEN_URL_V1;
    const cid   = isV2 ? CLIENT_ID_V2 : CLIENT_ID_V1;
    const extra = isV2 ? { scope: SCOPE_V2 } : {};
    const res   = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cid, grant_type: 'refresh_token', refresh_token: this._refreshToken, ...extra }).toString(),
    });
    if (!res.ok) {
      this.log('[WattsApi] Refresh failed, re-authenticating');
      return isV2 ? this._fetchTokenV2() : this._fetchTokenV1();
    }
    this._storeTokens(await res.json());
  }

  _storeTokens(data) {
    this._accessToken      = data.access_token;
    this._refreshToken     = data.refresh_token;
    this._tokenExpiresAt   = Date.now() + (data.expires_in - 30) * 1000;
    this._refreshExpiresAt = Date.now() + ((data.refresh_expires_in || 3600) - 30) * 1000;
  }

  async _ensureValidToken() {
    if (this._accessToken && Date.now() < this._tokenExpiresAt) return;
    if (this._refreshing) return this._refreshing;
    this._refreshing = (
      this._refreshToken && Date.now() < this._refreshExpiresAt
        ? this._doRefresh()
        : (this._apiVersion === 'v2' ? this._fetchTokenV2() : this._fetchTokenV1())
    ).finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────

  async _post(path, payload, retry = true) {
    await this._ensureValidToken();
    const baseUrl = this._apiVersion === 'v2' ? BASE_URL_V2 : BASE_URL_V1;
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + this._accessToken, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(payload).toString(),
    });
    if (res.status === 401 && retry) {
      this._accessToken = null; this._tokenExpiresAt = 0;
      await this._ensureValidToken();
      return this._post(path, payload, false);
    }
    const rawText = await res.text();
    this.log('[WattsApi]', res.status, path, rawText.substring(0, 300));
    if (!res.ok) throw new Error('API error ' + res.status + ': ' + rawText);
    let json;
    try { json = JSON.parse(rawText); } catch (e) { throw new Error('Non-JSON: ' + rawText); }
    if (json.code && json.code.code && json.code.code !== '1' && json.code.code !== '8') {
      throw new Error('Watts API error: [' + json.code.key + '] ' + json.code.value);
    }
    return json;
  }

  // ─── Data ──────────────────────────────────────────────────────────────────

  async getSmartHomes() {
    const result = await this._post('/api/v0.1/human/user/read/', { token: 'true', email: this._username, lang: 'en_GB' });
    const data   = result.data || {};
    const homes  = data.smarthomes || data.smarthome || (data.smarthome_id ? [data] : []);
    return homes.filter(h => h.smarthome_id || h.id).map(h => ({
      smarthome_id:    h.smarthome_id || h.id,
      smarthome_label: (h.label && h.label.trim()) || h.smarthome_label || h.address || h.smarthome_id || h.id,
      ...h,
    }));
  }

  async getSmartHome(smarthomeId) {
    const result = await this._post('/api/v0.1/human/smarthome/read/', { token: 'true', smarthome_id: smarthomeId, lang: 'en_GB' });
    return result.data;
  }

  async pushCommand(smarthomeId, deviceId, query) {
    return this._post('/api/v0.1/human/query/push/', {
      token: 'true', context: 1, smarthome_id: smarthomeId,
      'query[id_device]': deviceId, peremption: 15000, lang: 'en_GB',
      ...Object.fromEntries(Object.entries(query).map(([k, v]) => ['query[' + k + ']', v])),
    });
  }

  async setComfortTemperature(smarthomeId, deviceId, celsius) {
    const w = celsiusToWatts(celsius);
    return this.pushCommand(smarthomeId, deviceId, { time_boost: 0, consigne_confort: w, consigne_manuel: w, gv_mode: GV_MODE.COMFORT, nv_mode: GV_MODE.COMFORT });
  }
  async setEcoTemperature(smarthomeId, deviceId, celsius) {
    const w = celsiusToWatts(celsius);
    return this.pushCommand(smarthomeId, deviceId, { time_boost: 0, consigne_eco: w, gv_mode: GV_MODE.ECO, nv_mode: GV_MODE.ECO });
  }
  async setBoost(smarthomeId, deviceId, celsius, minutes) {
    const w = celsiusToWatts(celsius);
    const secs = Math.round(Math.max(1, Number(minutes))) * 60;
    return this.pushCommand(smarthomeId, deviceId, { time_boost: String(secs), consigne_boost: String(w), consigne_manuel: String(w), gv_mode: GV_MODE.BOOST, nv_mode: GV_MODE.BOOST, bit_override: '1' });
  }
  async setModeProgram(smarthomeId, deviceId) { return this.pushCommand(smarthomeId, deviceId, { time_boost: 0, gv_mode: GV_MODE.PROGRAM, nv_mode: GV_MODE.PROGRAM }); }
  async setModeEco(smarthomeId, deviceId)    { return this.pushCommand(smarthomeId, deviceId, { time_boost: 0, gv_mode: GV_MODE.ECO,     nv_mode: GV_MODE.ECO });     }
  async setModeOff(smarthomeId, deviceId)    { return this.pushCommand(smarthomeId, deviceId, { time_boost: 0, gv_mode: GV_MODE.OFF,     nv_mode: GV_MODE.OFF });     }
}

WattsApi.celsiusToWatts = celsiusToWatts;
WattsApi.wattsTocelsius = wattsTocelsius;
WattsApi.GV_MODE        = GV_MODE;
WattsApi.GV_MODE_LABELS = GV_MODE_LABELS;

module.exports = WattsApi;
