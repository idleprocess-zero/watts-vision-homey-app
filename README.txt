Control your Watts Vision+ smart heating system from Homey Pro.

Get real-time temperature readings for every zone, control heating modes, and automate your heating with Homey Flows — all without needing the Watts app.

---

FEATURES

- Live room temperature per zone (updated every 30 seconds)
- Set target (comfort) temperature directly from Homey
- All heating modes: Auto/Schedule, Comfort, Reduced/ECO, Boost, Anti-freeze
- Boost timer: heat to any temperature for 30 minutes up to 24 hours, then auto-return to schedule
- Heating active indicator: know when a zone is actually calling for heat
- Full Flow support: actions, conditions and triggers for complete home automation

---

REQUIREMENTS

- Homey Pro (SDK 3)
- A Watts Vision+ account
- A Watts Vision+ gateway (BT-CT02-RF, BT-CT03-RF or BT-ST03-RF) connected to the internet
- At least one thermostat zone configured in the Watts Vision+ app

---

SETUP

1. Go to Devices > Add device > Watts Vision+
2. Sign in with your Watts Vision+ email and password
3. All thermostat zones are discovered automatically
4. Select the zones you want to control from Homey

---

FLOW CARDS

Actions:
- Start boost heating (set temperature and duration)
- Stop boost and return to schedule
- Set heating mode (Auto/Schedule, Comfort, Reduced/ECO, Anti-freeze)

Conditions:
- Is [not] actively heating
- Boost mode [is / is not] active

Triggers:
- Heating mode changed (includes new mode as a Flow token)

---

DEVICE SETTINGS

Each thermostat has configurable defaults accessible via the gear icon:
- Poll interval (how often Homey checks for updates, default 30s)
- Default Reduced/ECO temperature (used when ECO activated from tile, default 16C)
- Default Boost temperature (used when Boost activated from tile, default 21C)
- Default Boost duration (used when Boost activated from tile, default 1 hour)

---

Not affiliated with Watts Electric. Watts Vision+ is a trademark of Watts Electric.
