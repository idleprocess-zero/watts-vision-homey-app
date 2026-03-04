'use strict';

const BASE_URL = 'https://smarthome.wattselectronics.com';
const TOKEN_URL = 'https://auth.smarthome.wattselectronics.com/realms/watts/protocol/openid-connect/token';
const CLIENT_ID = 'app-front';

// Temperature conversion: Watts API stores temperatures as tenths-of-Fahrenheit.
// e.g. 20°C → (20 × 1.8 + 32) × 10 = 680
function celsiusToWatts(celsius) {
  return Math.round((parseFloat(celsius) * 1.8 + 32) * 10);
}
function wattsTocelsius(wattsTemp) {
  return Math.round(((parseFloat(wattsTemp) / 10 - 32) / 1.8) * 10) / 10;
}

// gv_mode / nv_mode values used by the Watts API
const GV_MODE = { COMFORT: '0', PROGRAM: '1', ECO: '2', OFF: '3', BOOST: '4' };
const GV_MODE_LABELS = { '0': 'comfort', '1': 'program', '2': 'eco', '3': 'off', '4': 'boost', '11': 'eco' };

class WattsApi {
  constructor(log, error) {
    this.log = log || console.log;
    this.error = error || console.error;
    this._username = null;
    this._password = null;
    this._accessToken = null;
    this._refreshToken = null;
    this._tokenExpiresAt = null;
    this._refreshExpiresAt = null;
    this._refreshing = null;
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  async authenticate(username, password) {
    this._username = username;
    this._password = password;
    return this._fetchTokenWithPassword();
  }

  async _fetchTokenWithPassword() {
    this.log('[WattsApi] Authenticating...');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'password',
        username: this._username,
        password: this._password,
      }).toString(),
    });
    if (!res.ok) throw new Error('Auth failed (' + res.status + '): ' + await res.text());
    this._storeTokens(await res.json());
    this.log('[WattsApi] Authenticated successfully');
    return true;
  }

  async _fetchTokenWithRefresh() {
    this.log('[WattsApi] Refreshing token...');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: this._refreshToken,
      }).toString(),
    });
    if (!res.ok) {
      this.log('[WattsApi] Refresh failed, re-authenticating with password');
      return this._fetchTokenWithPassword();
    }
    this._storeTokens(await res.json());
    this.log('[WattsApi] Token refreshed');
    return true;
  }

  _storeTokens(data) {
    this._accessToken = data.access_token;
    this._refreshToken = data.refresh_token;
    this._tokenExpiresAt = Date.now() + (data.expires_in - 30) * 1000;
    this._refreshExpiresAt = Date.now() + (data.refresh_expires_in - 30) * 1000;
  }

  async _ensureValidToken() {
    if (this._accessToken && Date.now() < this._tokenExpiresAt) return;
    if (this._refreshing) return this._refreshing;
    this._refreshing = (
      this._refreshToken && Date.now() < this._refreshExpiresAt
        ? this._fetchTokenWithRefresh()
        : this._fetchTokenWithPassword()
    ).finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  // ─── HTTP ─────────────────────────────────────────────────────────────────

  async _post(path, payload, retry = true) {
    await this._ensureValidToken();

    // IMPORTANT: smarthome_id must be sent in base64url format exactly as returned
    // by user/read (e.g. "TkI6QzM6RDQ6RTU6RjY6QTc_e"). Do NOT decode to MAC address.
    const body = new URLSearchParams(payload).toString();

    const res = await fetch(BASE_URL + path, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + this._accessToken,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (res.status === 401 && retry) {
      this.log('[WattsApi] 401 received, re-authenticating...');
      this._accessToken = null;
      this._tokenExpiresAt = 0;
      await this._ensureValidToken();
      return this._post(path, payload, false);
    }

    const rawText = await res.text();
    if (!res.ok) throw new Error('API error ' + res.status + ': ' + rawText);

    let json;
    try { json = JSON.parse(rawText); }
    catch (e) { throw new Error('Non-JSON response: ' + rawText); }

    if (json.code && json.code.code && json.code.code !== '1' && json.code.code !== '8') {
      throw new Error('Watts API error: [' + json.code.key + '] ' + json.code.value);
    }

    return json;
  }

  // ─── Data ─────────────────────────────────────────────────────────────────

  /**
   * Get all smarthomes for the current user.
   * smarthome_id is returned in base64url format — use it as-is in all subsequent calls.
   */
  async getSmartHomes() {
    const result = await this._post('/api/v0.1/human/user/read/', {
      token: 'true',
      email: this._username,
      lang: 'en_GB',
    });

    const data = result.data || {};
    const homes = data.smarthomes || data.smarthome || (data.smarthome_id ? [data] : []);

    return homes.filter(h => h.smarthome_id || h.id).map(h => ({
      smarthome_id: h.smarthome_id || h.id,
      // Use address/city as label when the user hasn't set a custom name
      smarthome_label: (h.label && h.label.trim())
        || h.smarthome_label
        || h.address
        || h.city
        || h.place
        || h.mac_address
        || h.smarthome_id
        || h.id,
      ...h,
    }));
  }

  /**
   * Get full smarthome data including all zones and devices.
   * @param {string} smarthomeId - base64url id as returned by getSmartHomes()
   */
  async getSmartHome(smarthomeId) {
    const result = await this._post('/api/v0.1/human/smarthome/read/', {
      token: 'true',
      smarthome_id: smarthomeId,
      lang: 'en_GB',
    });
    return result.data;
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  async pushCommand(smarthomeId, deviceId, query) {
    const result = await this._post('/api/v0.1/human/query/push/', {
      token: 'true',
      context: 1,
      smarthome_id: smarthomeId,
      'query[id_device]': deviceId,
      peremption: 15000,
      lang: 'en_GB',
      ...Object.fromEntries(Object.entries(query).map(([k, v]) => ['query[' + k + ']', v])),
    });
    return result;
  }

  async setComfortTemperature(smarthomeId, deviceId, celsius) {
    const w = celsiusToWatts(celsius);
    return this.pushCommand(smarthomeId, deviceId, {
      time_boost: 0, consigne_confort: w, consigne_manuel: w,
      gv_mode: GV_MODE.COMFORT, nv_mode: GV_MODE.COMFORT,
    });
  }

  async setEcoTemperature(smarthomeId, deviceId, celsius) {
    const w = celsiusToWatts(celsius);
    return this.pushCommand(smarthomeId, deviceId, {
      time_boost: 0, consigne_eco: w,
      gv_mode: GV_MODE.ECO, nv_mode: GV_MODE.ECO,
    });
  }

  async setBoost(smarthomeId, deviceId, celsius, minutes) {
    const w    = celsiusToWatts(celsius);
    const mins = Math.round(Math.max(1, Number(minutes)));
    const secs = mins * 60; // time_boost is in SECONDS (confirmed: 60s = 60 sec boost, not 60 min)
    this.log('[WattsApi] setBoost:', w, 'watts,', mins, 'min (', secs, 'sec), device:', deviceId);
    return this.pushCommand(smarthomeId, deviceId, {
      time_boost:      String(secs),
      consigne_boost:  String(w),
      consigne_manuel: String(w),
      gv_mode:         GV_MODE.BOOST,
      nv_mode:         GV_MODE.BOOST,
      bit_override:    '1',
    });
  }

  async setModeProgram(smarthomeId, deviceId) {
    return this.pushCommand(smarthomeId, deviceId, {
      time_boost: 0, gv_mode: GV_MODE.PROGRAM, nv_mode: GV_MODE.PROGRAM,
    });
  }

  async setModeEco(smarthomeId, deviceId) {
    return this.pushCommand(smarthomeId, deviceId, {
      time_boost: 0, gv_mode: GV_MODE.ECO, nv_mode: GV_MODE.ECO,
    });
  }

  async setModeOff(smarthomeId, deviceId) {
    return this.pushCommand(smarthomeId, deviceId, {
      time_boost: 0, gv_mode: GV_MODE.OFF, nv_mode: GV_MODE.OFF,
    });
  }
}

WattsApi.celsiusToWatts = celsiusToWatts;
WattsApi.wattsTocelsius = wattsTocelsius;
WattsApi.GV_MODE = GV_MODE;
WattsApi.GV_MODE_LABELS = GV_MODE_LABELS;

module.exports = WattsApi;
