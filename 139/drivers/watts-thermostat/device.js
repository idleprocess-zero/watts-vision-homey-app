'use strict';

const Homey = require('homey');
const WattsApi = require('../../lib/WattsApi');

const POST_COMMAND_DELAY = 25 * 1000; // device takes ~13s to apply; poll after it settles
const MAX_ERROR_LOG      = 5;

class WattsThermostatDevice extends Homey.Device {

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onInit() {
    this.log('Initializing:', this.getName());
    this._pollTimer     = null;
    this._boostEndTimer = null;
    this._api           = null;
    this._errorLog      = [];
    this._hwErrorCaptured = false;
    // Pre-set alarm capabilities so rows always render on tile
    this.setCapabilityValue('watts_last_error', 'OK').catch(() => {});
    this.setCapabilityValue('alarm_heat', false).catch(() => {});
    this._pendingMode  = null; // mode we just sent — suppress UI flicker during device transition
    this._pendingTemp  = null; // temperature we just sent — suppress poll overwrite

    this._registerCapabilityListeners();
    await this._initApi();

    if (this._api) {
      await this._poll().catch(err => this._captureError('Initial poll failed', err));
      this._startPolling();
    }
  }

  async onAdded() {
    this.log('Device added:', this.getName());
  }

  async onDeleted() {
    this.log('Device deleted:', this.getName());
    this._stopPolling();
    if (this._boostEndTimer) this.homey.clearTimeout(this._boostEndTimer);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      this._stopPolling();
      this._startPolling(newSettings.poll_interval * 1000);
      this.log('Poll interval updated to', newSettings.poll_interval, 's');
    }
  }

  async reinitApi() {
    this._api = null;
    await this._initApi();
  }

  // ─── Error handling ────────────────────────────────────────────────────────

  async _captureError(context, err) {
    const msg       = err?.message || String(err);
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const entry     = `[${timestamp}] ${context}: ${msg}`;

    this.error(entry);
    this.homey.app.addDiagEntry(this.getName(), 'error', context + ': ' + msg);

    // Rolling log — newest first, max MAX_ERROR_LOG entries
    this._errorLog.unshift(entry);
    if (this._errorLog.length > MAX_ERROR_LOG) {
      this._errorLog = this._errorLog.slice(0, MAX_ERROR_LOG);
    }

    // Show last error text (accessible via Flow/insights)
    this.setCapabilityValue('watts_last_error', entry).catch(() => {});

    // Note: homey.notifications not available on all Homey Pro versions
    // Errors are visible in the device timeline via insights

    // Fire the error_occurred Flow trigger
    this.homey.app.triggerErrorOccurred(this, entry);
  }

  clearErrors() {
    // Called by Flow action or auto-clear on successful poll
    this._errorLog = [];
    this.setCapabilityValue('watts_last_error', 'OK').catch(() => {});
    this.log('Error log cleared');
  }

  getErrorLog() {
    return this._errorLog.length > 0
      ? this._errorLog.join('\n')
      : 'No errors recorded';
  }

  // ─── API init ──────────────────────────────────────────────────────────────

  async _initApi() {
    const credentials = this.getStoreValue('credentials');
    if (!credentials?.username || !credentials?.password) {
      await this.setUnavailable('No credentials stored — please re-add the device.');
      return;
    }

    this._api = new WattsApi(this.log.bind(this), this.error.bind(this));
    // Wire diagnostic log into API so auth/response details appear in settings page
    this._api._diagLog = (src, type, msg) => this.homey.app.addDiagEntry(src, type, msg);
    try {
      await this._api.authenticate(credentials.username, credentials.password);
    } catch (err) {
      this._captureError('Authentication failed', err);
      this._api = null;
      await this.setUnavailable('Authentication failed: ' + err.message);
    }
  }

  async _ensureApi() {
    if (!this._api) await this._initApi();
    if (!this._api) throw new Error('API unavailable — please re-add the device.');
  }

  // ─── Capability listeners ──────────────────────────────────────────────────

  _registerCapabilityListeners() {
    this.registerCapabilityListener('target_temperature', async (value) => {
      try {
        await this._ensureApi();
        const { smarthomeId, deviceId } = this.getData();
        this.log('Set comfort temperature:', value + '°C');
        this.homey.app.addDiagEntry(this.getName(), 'cmd', 'Set target temp → ' + value + 'C');
        // Update UI immediately — must return quickly to avoid Homey 10s timeout
        await this.setCapabilityValue('target_temperature', value).catch(this.error);
        this._pendingTemp = value;
        this.homey.app.triggerTargetTempChanged(this, value);
        await this._api.setComfortTemperature(smarthomeId, deviceId, value);
        // Fire repoll in background — don't await (would exceed 10s listener timeout)
        this._repollAfterCommand().then(() => { this._pendingTemp = null; })
          .catch(err => { this._pendingTemp = null; this._captureError('Post-temp poll failed', err); });
      } catch (err) {
        this._pendingTemp = null;
        this._captureError('Set temperature failed', err);
        throw err;
      }
    });

    this.registerCapabilityListener('watts_mode', async (value) => {
      try {
        // setWattsMode includes repoll — run the API call quickly and background the rest
        await this._ensureApi();
        const { smarthomeId, deviceId } = this.getData();
        const currentMode = this.getCapabilityValue('watts_mode');
        if (value === 'boost' && currentMode === 'boost') {
          this.log('Boost already active — tap ignored');
          return;
        }
        this.log('Set mode:', value);
        this._pendingMode = value;
        await this.setCapabilityValue('watts_mode', value).catch(this.error);
        // Fire the actual command and repoll in background
        this.setWattsMode(value).catch(err => this._captureError('Set mode failed', err));
      } catch (err) {
        this._captureError('Set mode failed', err);
        throw err;
      }
    });
  }

  // ─── Mode control ──────────────────────────────────────────────────────────

  async setWattsMode(mode) {
    await this._ensureApi();
    const { smarthomeId, deviceId } = this.getData();

    const currentMode = this.getCapabilityValue('watts_mode');
    if (mode === 'boost' && currentMode === 'boost') {
      this.log('Boost already active — tap ignored to preserve running boost');
      return;
    }

    this.log('Set mode:', mode);
    this._pendingMode = mode; // suppress UI flicker while device applies the command

    switch (mode) {
      case 'comfort': {
        const temp = this.getCapabilityValue('target_temperature') || 20;
        await this._api.setComfortTemperature(smarthomeId, deviceId, temp);
        break;
      }
      case 'program':
        await this._api.setModeProgram(smarthomeId, deviceId);
        break;
      case 'eco': {
        const ecoTemp = this.getSetting('eco_temperature') || 16;
        await this._api.setEcoTemperature(smarthomeId, deviceId, ecoTemp);
        break;
      }
      case 'off':
        await this._api.setModeOff(smarthomeId, deviceId);
        break;
      case 'boost': {
        const boostTemp = this.getSetting('boost_temperature') || 21;
        const boostMins = parseInt(this.getSetting('boost_duration') || '60', 10);
        await this.setBoost(boostTemp, boostMins);
        return;
      }
      default:
        throw new Error('Unknown mode: ' + mode);
    }

    await this.setCapabilityValue('watts_mode', mode).catch(this.error);
    await this._repollAfterCommand();
  }

  // ─── Boost ─────────────────────────────────────────────────────────────────

  async setBoost(celsius, minutes) {
    await this._ensureApi();
    const { smarthomeId, deviceId } = this.getData();

    const temp = Math.max(5, Math.min(30, Number(celsius)));
    const mins = Math.max(1, Math.round(Number(minutes)));

    if (this._boostEndTimer) {
      this.log('Boost already active — replacing with:', temp + '°C for', mins, 'min');
      this.homey.clearTimeout(this._boostEndTimer);
      this._boostEndTimer = null;
    } else {
      this.log('Boost:', temp + '°C for', mins, 'min');
    this.homey.app.addDiagEntry(this.getName(), 'cmd', 'Boost ' + temp + 'C for ' + mins + 'min');
    }

    this._pendingMode = 'boost'; // suppress poll UI flicker while device applies command
    await this._api.setBoost(smarthomeId, deviceId, temp, mins);

    await this.setCapabilityValue('watts_mode', 'boost').catch(this.error);
    await this.setCapabilityValue('target_temperature', temp).catch(this.error);
    await this.setCapabilityValue('watts_boost_remaining', mins).catch(this.error);

    this.driver.triggerModeChanged(this, 'boost');
    this.homey.app.triggerBoostStarted(this, temp, mins);

    this._boostEndTimer = this.homey.setTimeout(async () => {
      this.log('Boost timer expired — polling device for actual mode');
      this._boostEndTimer = null;
      await this.setCapabilityValue('watts_boost_remaining', 0).catch(this.error);
      this.homey.app.triggerBoostEnded(this);
      // Don't assume mode — let the next poll read the actual mode from the device
      await this._poll().catch(this.error);
    }, mins * 60 * 1000);

    await this._repollAfterCommand();
  }

  async stopBoost() {
    if (this._boostEndTimer) {
      this.homey.clearTimeout(this._boostEndTimer);
      this._boostEndTimer = null;
    }
    await this.setCapabilityValue('watts_boost_remaining', 0).catch(this.error);
    await this.setWattsMode('program');
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  _startPolling(intervalMs) {
    const ms = intervalMs || (this.getSetting('poll_interval') || 30) * 1000;
    this._pollTimer = this.homey.setInterval(() => this._poll(), ms);
    this.log('Polling every', ms / 1000, 's');
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _repollAfterCommand() {
    await new Promise(r => this.homey.setTimeout(r, POST_COMMAND_DELAY));
    await this._poll().catch(err => this._captureError('Post-command poll failed', err));
  }

  async _poll() {
    if (!this._api) {
      await this._initApi();
      if (!this._api) return;
    }

    const { smarthomeId, deviceId } = this.getData();

    try {
      const homeData = await this._api.getSmartHome(smarthomeId);

      const zones = homeData.zones || [];
      let deviceData = null;
      for (const zone of zones) {
        deviceData = (zone.devices || []).find(d => d.id_device === deviceId);
        if (deviceData) break;
      }

      if (!deviceData) {
        this._captureError('Device not found', new Error('Check your gateway is online'));
        await this.setUnavailable('Device not found — check your gateway is online.');
        return;
      }

      await this._updateCapabilities(deviceData);
      await this.setAvailable();
      this.homey.app.addDiagEntry(this.getName(), 'poll', 'OK — mode:' + (deviceData.gv_mode || '?') + ' temp:' + (deviceData.temperature_air || '?'));

      // Auto-clear last error text on successful poll if it was a connection error
      const lastErr = this.getCapabilityValue('watts_last_error') || '';
      if (lastErr && lastErr !== 'OK' && !this._hwErrorCaptured) {
        this.log('Connection restored — auto-clearing error');
        this.clearErrors();
      }

    } catch (err) {
      this._captureError('Poll failed', err);
      if (err.message.includes('401') || err.message.includes('auth')) {
        await this.setUnavailable('Authentication error — please repair the device.');
      } else {
        await this.setUnavailable('Connection error: ' + err.message);
      }
    }
  }

  async _updateCapabilities(device) {
    const gvMode  = String(device.gv_mode ?? '1');
    const prevMode = this.getCapabilityValue('watts_mode');
    const modeLabel = WattsApi.GV_MODE_LABELS[gvMode] || 'program';

    // If we're waiting for a command to apply and the device hasn't caught up yet,
    // skip updating mode/setpoint to avoid UI flicker. Temperature still updates.
    if (this._pendingMode && modeLabel !== this._pendingMode) {
      this.log('Skipping mode update — device mid-transition (pending:', this._pendingMode, ', got:', modeLabel + ')');
      if (device.temperature_air != null) {
        await this.setCapabilityValue('measure_temperature',
          WattsApi.wattsTocelsius(device.temperature_air)).catch(this.error);
      }
      return;
    }
    // Device has caught up — clear the pending flag
    if (this._pendingMode && modeLabel === this._pendingMode) {
      this.log('Device settled on:', modeLabel, '— clearing pending flag');
      this._pendingMode = null;
      this.homey.app.addDiagEntry(this.getName(), 'info', 'Settled on: ' + modeLabel);
    }

    // Current room temperature
    if (device.temperature_air != null) {
      const newTemp = WattsApi.wattsTocelsius(device.temperature_air);
      const prevTemp = this.getCapabilityValue('measure_temperature');
      await this.setCapabilityValue('measure_temperature', newTemp).catch(this.error);

      // Fire temperature threshold triggers on crossing
      if (prevTemp !== null && prevTemp !== undefined) {
        if (newTemp < prevTemp) {
          this.homey.app.triggerTempDroppedBelow(this, newTemp);
        } else if (newTemp > prevTemp) {
          this.homey.app.triggerTempRisenAbove(this, newTemp);
        }
      }
    }

    // Target temperature per mode — matched to what Watts app displays
    let targetRaw = null;
    switch (gvMode) {
      case WattsApi.GV_MODE.BOOST:
        targetRaw = device.consigne_boost;   break; // boost target temp
      case WattsApi.GV_MODE.COMFORT:
        targetRaw = device.consigne_confort; break; // manual comfort setpoint
      case WattsApi.GV_MODE.ECO:
      case '11':
        targetRaw = device.consigne_eco;     break; // eco setpoint (NOT consigne_hg = antifreeze floor)
      case WattsApi.GV_MODE.OFF:
        targetRaw = device.consigne_hg;     break; // antifreeze floor for off mode
      default: // PROGRAM — show comfort setpoint as best approximation
        targetRaw = device.consigne_confort; break;
    }
    if (targetRaw != null && this._pendingTemp === null) {
      // Only update from API if we don't have a pending temperature command
      await this.setCapabilityValue('target_temperature',
        WattsApi.wattsTocelsius(targetRaw)).catch(this.error);
    }

    // Heating mode
    await this.setCapabilityValue('watts_mode', modeLabel).catch(this.error);

    if (modeLabel !== prevMode) {
      this.driver.triggerModeChanged(this, modeLabel);
    }

    // Heating active
    const heatingUp = device.heating_up === '1' || device.heating_up === 1;
    await this.setCapabilityValue('alarm_heat', heatingUp).catch(this.error);

    // Hardware error code — update watts_last_error with decoded message
    const hwError = parseInt(device.error_code || '0', 10);
    if (hwError !== 0) {
      // Always keep the alarm indicator in sync
      // Only log/capture once per session to avoid flooding
      if (!this._hwErrorCaptured) {
        this._hwErrorCaptured = true;
        const hwErrorMsg = {
          1: 'Battery failure — replace thermostat battery',
          2: 'Temperature sensor fault',
          3: 'Communication error with gateway',
          4: 'Floor sensor fault',
        }[hwError] || ('Hardware error code ' + hwError);
        this._captureError('Thermostat hardware alert', new Error(hwErrorMsg));
      }
    } else {
      // error_code = 0 — clear error status
      if (this._hwErrorCaptured) {
        this._hwErrorCaptured = false;
        this.setCapabilityValue('watts_last_error', 'OK').catch(() => {});
        this.log('Hardware error cleared by device');
        this.homey.app.triggerErrorCleared(this);
      }
    }

    // Boost remaining
    const boostRemaining = gvMode === WattsApi.GV_MODE.BOOST
      ? parseInt(device.time_boost || '0', 10) : 0;
    await this.setCapabilityValue('watts_boost_remaining', boostRemaining).catch(this.error);

    // Cancel local boost timer if API confirms boost ended externally
    if (gvMode !== WattsApi.GV_MODE.BOOST && this._boostEndTimer) {
      this.homey.clearTimeout(this._boostEndTimer);
      this._boostEndTimer = null;
      this.homey.app.triggerBoostEnded(this);
    }
  }
}

module.exports = WattsThermostatDevice;
