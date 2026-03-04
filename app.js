'use strict';

const Homey = require('homey');

class WattsVisionApp extends Homey.App {

  async onInit() {
    this.log('Watts Vision+ app initialising');

    // ── App-wide diagnostic log ──────────────────────────────────────────
    this._diagLog = [];
    this._diagMax = 100;
    this.homey.settings.set('diagnosticLog', '');
    this.homey.settings.set('diagnosticInfo', {
      version: this.homey.manifest.version,
      deviceCount: 0,
      logCount: 0,
    });

    // ── Triggers ────────────────────────────────────────────────────────
    this._triggerModeChanged          = this.homey.flow.getDeviceTriggerCard('mode_changed');
    this._triggerErrorOccurred        = this.homey.flow.getDeviceTriggerCard('error_occurred');
    this._triggerErrorCleared         = this.homey.flow.getDeviceTriggerCard('error_cleared');
    this._triggerBoostStarted         = this.homey.flow.getDeviceTriggerCard('boost_started');
    this._triggerBoostEnded           = this.homey.flow.getDeviceTriggerCard('boost_ended');
    this._triggerTargetTempChanged    = this.homey.flow.getDeviceTriggerCard('target_temperature_changed');
    this._triggerTempDroppedBelow     = this.homey.flow.getDeviceTriggerCard('temperature_dropped_below');
    this._triggerTempRisenAbove       = this.homey.flow.getDeviceTriggerCard('temperature_risen_above');

    this._triggerTempDroppedBelow.registerRunListener(async (args, state) => {
      return state.temperature <= args.temperature;
    });
    this._triggerTempRisenAbove.registerRunListener(async (args, state) => {
      return state.temperature >= args.temperature;
    });

    // ── Actions ─────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('set_boost').registerRunListener(async ({ temperature, duration_minutes, device }) => {
      await device.setBoost(temperature, parseInt(duration_minutes, 10));
    });

    this.homey.flow.getActionCard('stop_boost').registerRunListener(async ({ device }) => {
      await device.stopBoost();
    });

    this.homey.flow.getActionCard('set_thermostat_mode').registerRunListener(async ({ mode, device }) => {
      await device.setWattsMode(mode);
    });

    this.homey.flow.getActionCard('clear_errors').registerRunListener(async ({ device }) => {
      device.clearErrors();
    });

    this.homey.flow.getActionCard('set_all_eco').registerRunListener(async () => {
      await this._setAllDevices('eco');
    });

    this.homey.flow.getActionCard('set_all_antifreeze').registerRunListener(async () => {
      await this._setAllDevices('off');
    });

    this.homey.flow.getActionCard('set_all_schedule').registerRunListener(async () => {
      await this._setAllDevices('program');
    });

    // ── Conditions ──────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('is_heating').registerRunListener(async ({ device }) => {
      return device.getCapabilityValue('alarm_heat') === true;
    });

    this.homey.flow.getConditionCard('is_boost_active').registerRunListener(async ({ device }) => {
      return device.getCapabilityValue('watts_mode') === 'boost';
    });

    this.homey.flow.getConditionCard('has_error').registerRunListener(async ({ device }) => {
      const status = device.getCapabilityValue('watts_last_error') || 'OK';
      return status !== 'OK';
    });

    this.log('Watts Vision+ app ready');
  }

  // ── Set all devices ───────────────────────────────────────────────────

  async _setAllDevices(mode) {
    const driver = this.homey.drivers.getDriver('watts-thermostat');
    const devices = driver.getDevices();
    await Promise.allSettled(devices.map(d => d.setWattsMode(mode)));
    this.log('Set all devices to:', mode, '(' + devices.length + ' devices)');
  }

  // ── Diagnostic log ────────────────────────────────────────────────────

  addDiagEntry(deviceName, type, message) {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    // Sanitise personal data
    const clean = message
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email]')
      .replace(/([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}/g, '[mac]')
      .replace(/Njg[a-zA-Z0-9_-]+/g, '[id]')
      .replace(/C00[0-9]-[0-9]{3}/g, '[device-id]');

    const entry = '[' + ts + '] [' + type.toUpperCase() + '] ' + deviceName + ': ' + clean;
    this._diagLog.unshift(entry);
    if (this._diagLog.length > this._diagMax) {
      this._diagLog = this._diagLog.slice(0, this._diagMax);
    }
    this._flushDiagSettings();
  }

  _flushDiagSettings() {
    const driver = this.homey.drivers.getDriver('watts-thermostat');
    const deviceCount = driver ? driver.getDevices().length : 0;
    const lines = [
      '=== Watts Vision+ Diagnostic Report ===',
      'Version:   ' + this.homey.manifest.version,
      'Devices:   ' + deviceCount,
      'Entries:   ' + this._diagLog.length,
      'Generated: ' + new Date().toISOString().replace('T', ' ').substring(0, 19),
      '=======================================',
      '',
    ].concat(this._diagLog);

    this.homey.settings.set('diagnosticLog', lines.join('\n'));
    this.homey.settings.set('diagnosticInfo', {
      version: this.homey.manifest.version,
      deviceCount,
      logCount: this._diagLog.length,
    });
  }

  // ── Trigger helpers ───────────────────────────────────────────────────

  triggerModeChanged(device, mode) {
    this._triggerModeChanged
      .trigger(device, { mode }, {})
      .catch(err => this.error('mode_changed trigger failed:', err.message));
  }

  triggerErrorOccurred(device, errorMessage) {
    this._triggerErrorOccurred
      .trigger(device, { error: errorMessage }, {})
      .catch(err => this.error('error_occurred trigger failed:', err.message));
  }

  triggerErrorCleared(device) {
    this._triggerErrorCleared
      .trigger(device, {}, {})
      .catch(err => this.error('error_cleared trigger failed:', err.message));
  }

  triggerBoostStarted(device, temperature, duration) {
    this._triggerBoostStarted
      .trigger(device, { temperature, duration }, {})
      .catch(err => this.error('boost_started trigger failed:', err.message));
  }

  triggerBoostEnded(device) {
    this._triggerBoostEnded
      .trigger(device, {}, {})
      .catch(err => this.error('boost_ended trigger failed:', err.message));
  }

  triggerTargetTempChanged(device, temperature) {
    this._triggerTargetTempChanged
      .trigger(device, { temperature }, {})
      .catch(err => this.error('target_temperature_changed trigger failed:', err.message));
  }

  triggerTempDroppedBelow(device, temperature) {
    this._triggerTempDroppedBelow
      .trigger(device, { temperature }, { temperature })
      .catch(err => this.error('temperature_dropped_below trigger failed:', err.message));
  }

  triggerTempRisenAbove(device, temperature) {
    this._triggerTempRisenAbove
      .trigger(device, { temperature }, { temperature })
      .catch(err => this.error('temperature_risen_above trigger failed:', err.message));
  }
}

module.exports = WattsVisionApp;
