'use strict';

const Homey = require('homey');
const WattsApi = require('../../lib/WattsApi');

class WattsThermostatDriver extends Homey.Driver {
  async onInit() {
    this.log('Watts Vision+ thermostat driver initialized');

    // Register the mode_changed trigger card once at driver level
    this._modeChangedTrigger = this.homey.flow.getDeviceTriggerCard('mode_changed');
  }

  /**
   * Fire the mode_changed trigger for a device.
   * Called by device.js whenever the heating mode changes.
   */
  triggerModeChanged(device, mode) {
    this._modeChangedTrigger
      .trigger(device, { mode })
      .catch(err => this.error('mode_changed trigger failed:', err.message));
  }

  async onPair(session) {
    const api = new WattsApi(this.log.bind(this), this.error.bind(this));
    let credentials = null;

    session.setHandler('login', async ({ username, password }) => {
      try {
        await api.authenticate(username, password);
        credentials = { username, password, apiVersion: api._apiVersion };
        this.log('Login successful on platform:', api._apiVersion);
        return true;
      } catch (err) {
        // Log full detail to app log for diagnosis
        this.error('Login failed (full):', err.message);
        // Built-in template needs a short message — truncate to 120 chars
        const short = err.message.length > 120 ? err.message.substring(0, 120) + '…' : err.message;
        throw new Error(short);
      }
    });

    session.setHandler('list_devices', async () => {
      if (!credentials) throw new Error('Not authenticated');

      // Fetch smarthomes with retry
      let smarthomes = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          smarthomes = await api.getSmartHomes();
          if (smarthomes.length > 0) break;
        } catch (err) {
          this.log('user/read attempt', attempt, 'failed:', err.message);
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (smarthomes.length === 0) {
        throw new Error('Could not retrieve smarthome list. Check your credentials and internet connection.');
      }

      const devices = [];

      for (const home of smarthomes) {
        const { smarthome_id: smarthomeId, smarthome_label: homeLabel } = home;
        this.log('Processing smarthome:', homeLabel);

        // Fetch device list with retry
        let homeData = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            homeData = await api.getSmartHome(smarthomeId);
            if (homeData) break;
          } catch (err) {
            this.log('smarthome/read attempt', attempt, 'failed:', err.message);
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          }
        }

        if (!homeData) {
          this.error('Could not fetch devices for', smarthomeId);
          continue;
        }

        // Collect ALL devices from zones (primary source) and top-level devices (fallback)
        // The API nests devices inside zones[] — top-level devices[] may be empty or incomplete
        const allDevices = [];
        const zoneLabels = {};

        for (const zone of (homeData.zones || [])) {
          const label = zone.zone_label || zone.zone_name || ('Zone ' + zone.num_zone);
          for (const zd of (zone.devices || [])) {
            const id = zd.id_device || (zd.id && zd.id.split('#')[1]);
            if (id) {
              zoneLabels[id] = label;
              allDevices.push(zd);
            }
          }
        }

        // Also include any top-level devices not already found in zones
        for (const d of (homeData.devices || [])) {
          const id = d.id_device;
          if (id && !allDevices.find(x => x.id_device === id)) {
            allDevices.push(d);
          }
        }

        this.log('Total devices found across all zones:', allDevices.length);

        for (const device of allDevices) {
          const deviceId = device.id_device;
          if (!deviceId) continue;

          // Skip gateway and central unit entries
          const type = String(device.device_type || '');
          if (type === 'gateway' || type === 'central_unit') continue;

          const deviceName = device.nom_appareil || device.label_interface || deviceId;
          const zoneName = zoneLabels[deviceId];
          const displayName = zoneName && zoneName !== deviceName
            ? deviceName + ' (' + zoneName + ')'
            : deviceName;

          devices.push({
            name: displayName,
            data: { id: smarthomeId + ':' + deviceId, deviceId, smarthomeId },
            store: { credentials },
            capabilities: ['measure_temperature', 'target_temperature', 'watts_mode', 'alarm_heat', 'watts_boost_remaining'],
            capabilitiesOptions: { target_temperature: { min: 5, max: 30, step: 0.5 } },
          });

          this.log('Found:', displayName, '(' + deviceId + ')');
        }
      }

      if (devices.length === 0) {
        throw new Error('No thermostat devices found. Make sure your gateway is online and zones are configured.');
      }

      return devices;
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async ({ username, password }) => {
      try {
        const api = new WattsApi(this.log.bind(this), this.error.bind(this));
        await api.authenticate(username, password);
        await device.setStoreValue('credentials', { username, password, apiVersion: api._apiVersion });
        await device.reinitApi();
        this.log('Re-auth successful for:', device.getName(), 'platform:', api._apiVersion);
        return true;
      } catch (err) {
        this.error('Re-auth failed:', err.message);
        throw new Error(err.message);
      }
    });
  }
}

module.exports = WattsThermostatDriver;
