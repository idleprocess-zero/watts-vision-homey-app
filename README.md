# Watts Vision for Homey - and working on Watts Vision+ support at the moment as well

Control your **Watts Vision+** smart heating system directly from Homey Pro — with real-time temperature readings, full mode control, boost/timer heating, and complete Flow automation support.

Developed by **idleprocess-zero**  •  v1.3.1.17

---

## Features

- 🌡️ **Live temperature** — current room temperature per zone, updated every 30 seconds
- 🎯 **Target temperature** — adjust the comfort setpoint directly from Homey
- 🔄 **All heating modes** — Auto/Schedule, Comfort, Reduced/ECO, Boost, Anti-freeze
- ⏱️ **Boost timer** — heat to any temperature for 30 min up to 24 hours, then auto-return to schedule
- 🔔 **Heating active indicator** — know when a zone is actually calling for heat
- 🔁 **Automatic token refresh** — access tokens refreshed silently; full re-auth with stored credentials when needed
- 🔧 **Full Flow support** — actions, conditions and triggers for complete automation
- 🔴 **Error indicator** — red ! circle on device tile when an error occurs; auto-clears on recovery
- 📋 **Error log** — last 5 errors captured with timestamps, viewable as a capability

---

## Requirements

- Homey Pro (SDK 3, Homey >= 5.0.0)
- A Watts Vision+ account (smarthome.wattselectronics.com)
- A Watts Vision+ gateway (BT-CT02-RF) connected to the internet
- At least one thermostat zone paired to the gateway in the Watts app

Working on adding support for the newer verions
- A Watts Vision+ gateway (BT-CT03-RF or BT-ST33-RF) connected to the internet
---

## Pairing

1. In Homey, go to **Devices > Add device > Watts Vision+**
2. Enter your Watts Vision+ **email address** and **password**
   - Password managers (1Password, Bitwarden, etc.) can autofill the login screen
3. All thermostat zones on your account are discovered automatically
4. Select the zones you want to add

---

## Device Settings

Tap the gear icon on any device tile to configure per-device options:

| Setting | Default | Description |
|---|---|---|
| Poll interval | 30s | How often Homey checks the cloud for updates (10-300s) |
| Default Reduced/ECO temperature | 16C | Temperature used when ECO is activated from the tile |
| Default Boost temperature | 21C | Temperature used when Boost is activated from the tile |
| Default Boost duration | 1 hour | Duration used when Boost is activated from the tile |

---

## Flow Cards

### Actions
| Card | Arguments | Description |
|---|---|---|
| Start boost heating | Temperature (C), Duration | Boost to a set temperature for 30 min to 24h, then return to schedule. Replaces any running boost. |
| Stop boost | - | Cancel boost immediately and return to Auto/Schedule |
| Clear error log | - | Reset the error indicator and clear the error log |
| Set heating mode | Mode | Switch to Auto/Schedule, Comfort, Reduced/ECO, or Anti-freeze |

### Conditions
| Card | Description |
|---|---|
| Is [not] actively heating | True when the zone is calling for heat |
| Boost mode [is / is not] active | True when boost is running |
| Device [has / has no] active error | True when the error indicator is showing |

### Triggers
| Card | Tokens | Description |
|---|---|---|
| Heating mode changed | New mode (text) | Fires on any mode change - from command or schedule |
| An error occurred | Error message (text) | Fires when any error is captured, with timestamp |

---

## Heating Modes

| Homey label | Watts app label | API gv_mode |
|---|---|---|
| Auto / Schedule | Auto | 1 | Comfort setpoint (schedule varies by time slot) |
| Comfort | Comfort | 0 | Comfort setpoint (consigne_confort) |
| Reduced / ECO | Reduced | 2 | HG/frost floor (consigne_hg — matches Watts app) |
| Boost | Boost/Timer | 4 | Boost setpoint (consigne_boost) |
| Anti-freeze | Anti-freeze / Off | 3 | HG/frost floor (consigne_hg) |

---

## Boost Behaviour

- Tapping **Boost** in the device tile while boost is already running does nothing — the active boost is preserved
- To replace a running boost with different settings, use the **"Start boost heating"** Flow action, or stop it first via **"Stop boost"**
- To cancel boost at any time, select any other mode from the tile or use the **"Stop boost"** Flow action

---

## Re-authentication

If your password changes or authentication fails:

1. Long-press the device tile and tap Repair device
2. Enter your updated credentials
3. The app re-authenticates and resumes polling immediately

---

## Known Limitations

- Switch/actuator devices are not yet supported - thermostats only
- The Watts cloud API is not officially documented; Watts may change it at any time
- Polling-based: there is up to one poll interval of delay between a physical thermostat change and Homey reflecting it

---

## License

MIT

---

## Changelog

### v1.3.6
- Fix: Login screen blank on pairing — template key was missing since v1.3.4

### v1.3.3
- Fix: Diagnostic settings page now opens correctly
- Fix: Log data loads using correct Homey settings API

### v1.3.1
- Added: Diagnostic log in app settings — copy all device logs to clipboard for support
- Fix: Login error now shows friendly message with link to smarthome.wattselectronics.com
- Docs: Orange background explained (Homey thermostat UI behaviour, not an error)
- Docs: Timing delays documented (30s poll, 13s command delay, boiler response time)

### v1.3.0 (publish release)
- All debug logging removed
- Personal data removed from log output

### v1.2.4
- Fix: Multi-zone pairing — devices now collected from all zones, not just top-level list
- Users with 4+ thermostats will now see all devices during pairing (re-pair required)

### v1.2.3
- Fix: Timeout after 10000ms on temperature/mode changes — repoll now runs in background
- Fix: Personal data (email, MAC) removed from pairing log output
- Fix: heating_up correctly written on every poll — prevents stale orange background

### v1.2.2
- Debug: Added heating_up raw logging to diagnose orange background

### v1.2.1
- Fix: Boost expiry no longer assumes Auto/Schedule — polls device for actual revert mode

### v1.2.0
- Added 6 new Flow triggers:
  - Temperature dropped below X°C
  - Temperature rose above X°C
  - Target temperature changed (with new setpoint token)
  - Boost started (with temperature and duration tokens)
  - Boost ended (on timer expiry or external cancel)
  - Device error cleared (e.g. after battery replaced)
- Added 3 new Flow actions:
  - Set ALL thermostats to Reduced/ECO
  - Set ALL thermostats to Anti-freeze
  - Set ALL thermostats to Auto/Schedule

### v1.1.1
- Fix: Login screen white/blank on mobile — reverted to Homey built-in login template
- Fix: Temperature change shown immediately in UI — no more waiting for poll
- Fix: Temperature change no longer triggers 10s timeout red banner

### v1.1.0
- Full publish build — all debug logging removed
- Push notification confirmed working on Homey Pro
- Boost duration fixed — time_boost sent in seconds
- Flow card dropdowns working — device arg in correct position
- Mode changes no longer flicker — pending mode guard
- ECO setpoint correct — shows eco temperature not antifreeze floor
- Hardware error codes decoded: Battery failure, Sensor fault, etc.
- Actively Heating indicator (renamed from Heat Alarm)
- Device Status row shows OK or error message

### v1.0.0
- Initial release
- All heating modes: Auto/Schedule, Comfort, Reduced/ECO, Boost, Anti-freeze
- Boost timer with configurable temperature and duration (30 min – 24 h)
- Full Flow support: actions, conditions, triggers
- Automatic OAuth2 token refresh and re-authentication

---

Not affiliated with Watts Electric. Watts Vision+ is a trademark of Watts Electric.
