/**
 * Generated runtime identity and admission data from the human-edited device catalogue.
 *
 * The catalogue generator owns this file. Provider capability modules consume
 * these immutable records and must not add device identities independently.
 */

/** One catalogue record with a confirmed numeric inventory type. */
export interface GeneratedCatalogueDevice {
  readonly deviceType: number;
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly models: readonly string[];
  readonly status: "supported" | "ready_to_test" | "recognised";
  readonly handler: "camera" | "sensor" | "homebase" | null;
}

/** Every typed device known to the contributor-maintained catalogue. */
export const GENERATED_CATALOGUE_DEVICES: readonly GeneratedCatalogueDevice[] = [
  {
    "id": "t8001",
    "name": "HomeBase (original)",
    "category": "homebase",
    "models": [
      "T8001"
    ],
    "deviceType": 0,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8002",
    "name": "HomeBase E",
    "category": "homebase",
    "models": [
      "T8002"
    ],
    "deviceType": 0,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8010",
    "name": "HomeBase 2 (S280)",
    "category": "homebase",
    "models": [
      "T8010",
      "T80101D2"
    ],
    "deviceType": 0,
    "status": "supported",
    "handler": "homebase"
  },
  {
    "id": "t8111",
    "name": "eufyCam (original)",
    "category": "camera",
    "models": [
      "T8111"
    ],
    "deviceType": 1,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t87a0",
    "name": "Smart Display E10",
    "category": "hub_adjacent",
    "models": [
      "T87A0",
      "T87A01W1",
      "T87A0120"
    ],
    "deviceType": 1,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8900",
    "name": "Entry Sensor",
    "category": "security_sensor",
    "models": [
      "T8900",
      "T89000D1",
      "T89000D4"
    ],
    "deviceType": 2,
    "status": "ready_to_test",
    "handler": "sensor"
  },
  {
    "id": "t8420-standard",
    "name": "Floodlight Cam 1080p",
    "category": "camera",
    "models": [
      "T8420"
    ],
    "deviceType": 3,
    "status": "ready_to_test",
    "handler": "camera"
  },
  {
    "id": "t8420-variant-6",
    "name": "Floodlight Cam (T8420X hardware variant)",
    "category": "camera",
    "models": [
      "T8420"
    ],
    "deviceType": 3,
    "status": "ready_to_test",
    "handler": "camera"
  },
  {
    "id": "t8112",
    "name": "eufyCam E",
    "category": "camera",
    "models": [
      "T8112"
    ],
    "deviceType": 4,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8200-standard",
    "name": "Video Doorbell 2K (Wired)",
    "category": "doorbell",
    "models": [
      "T8200"
    ],
    "deviceType": 5,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8200-variant-6",
    "name": "Video Doorbell 2K (T8200X variant)",
    "category": "doorbell",
    "models": [
      "T8200"
    ],
    "deviceType": 5,
    "status": "ready_to_test",
    "handler": "camera"
  },
  {
    "id": "t8201",
    "name": "Wired Video Doorbell (T8201)",
    "category": "doorbell",
    "models": [
      "T8201",
      "T8201X"
    ],
    "deviceType": 5,
    "status": "ready_to_test",
    "handler": "camera"
  },
  {
    "id": "t8210",
    "name": "Video Doorbell S220",
    "category": "doorbell",
    "models": [
      "T8210",
      "T8210C"
    ],
    "deviceType": 7,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8113",
    "name": "eufyCam 2C",
    "category": "camera",
    "models": [
      "T8113",
      "T8113-Z"
    ],
    "deviceType": 8,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8114",
    "name": "eufyCam 2",
    "category": "camera",
    "models": [
      "T8114"
    ],
    "deviceType": 9,
    "status": "ready_to_test",
    "handler": "camera"
  },
  {
    "id": "t8910",
    "name": "Motion Sensor",
    "category": "security_sensor",
    "models": [
      "T8910",
      "T8910021"
    ],
    "deviceType": 10,
    "status": "ready_to_test",
    "handler": "sensor"
  },
  {
    "id": "t8960",
    "name": "Keypad",
    "category": "keypad",
    "models": [
      "T8960",
      "T8960021"
    ],
    "deviceType": 11,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8140",
    "name": "eufyCam 2 Pro (S221)",
    "category": "camera",
    "models": [
      "T8140",
      "T8140R",
      "T8140-R"
    ],
    "deviceType": 14,
    "status": "ready_to_test",
    "handler": "camera"
  },
  {
    "id": "t8141",
    "name": "eufyCam 2C Pro (S220)",
    "category": "camera",
    "models": [
      "T8141",
      "T8142",
      "T8142-Z"
    ],
    "deviceType": 15,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8222",
    "name": "Video Doorbell C210 / 1080p (Battery)",
    "category": "doorbell",
    "models": [
      "T8222"
    ],
    "deviceType": 16,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8030",
    "name": "HomeBase 3 (S380)",
    "category": "homebase",
    "models": [
      "T8030",
      "T80301D1",
      "T8030TD1"
    ],
    "deviceType": 18,
    "status": "supported",
    "handler": "homebase"
  },
  {
    "id": "t8160",
    "name": "eufyCam 3 (S330)",
    "category": "camera",
    "models": [
      "T8160"
    ],
    "deviceType": 19,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8920",
    "name": "Water and Freeze Sensor",
    "category": "security_sensor",
    "models": [
      "T8920",
      "T89200D1"
    ],
    "deviceType": 20,
    "status": "ready_to_test",
    "handler": "sensor"
  },
  {
    "id": "t8161",
    "name": "eufyCam 3C (S300)",
    "category": "camera",
    "models": [
      "T8161"
    ],
    "deviceType": 23,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8600",
    "name": "eufyCam E330 (Professional)",
    "category": "camera",
    "models": [
      "T8600"
    ],
    "deviceType": 24,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8023",
    "name": "MiniBase Chime",
    "category": "hub_adjacent",
    "models": [
      "T8023"
    ],
    "deviceType": 25,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8162",
    "name": "eufyCam S3 Pro",
    "category": "camera",
    "models": [
      "T8162"
    ],
    "deviceType": 26,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t9000",
    "name": "HomeBase Professional S1",
    "category": "homebase",
    "models": [
      "T9000",
      "T9000121"
    ],
    "deviceType": 27,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8025",
    "name": "HomeBase Mini",
    "category": "homebase",
    "models": [
      "T8025"
    ],
    "deviceType": 28,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8400",
    "name": "Indoor Cam C120 / 2K (Solo IndoorCam C24)",
    "category": "camera",
    "models": [
      "T8400"
    ],
    "deviceType": 30,
    "status": "ready_to_test",
    "handler": "camera"
  },
  {
    "id": "t8410",
    "name": "Indoor Cam E220 / 2K Pan & Tilt (Solo IndoorCam P24)",
    "category": "camera",
    "models": [
      "T8410",
      "T8413"
    ],
    "deviceType": 31,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8410c",
    "name": "Indoor Cam Pan & Tilt 2K (T8410C)",
    "category": "camera",
    "models": [
      "T8410C",
      "T8410C21"
    ],
    "deviceType": 31,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8130",
    "name": "SoloCam E20",
    "category": "camera",
    "models": [
      "T8130"
    ],
    "deviceType": 32,
    "status": "ready_to_test",
    "handler": "camera"
  },
  {
    "id": "t8131",
    "name": "SoloCam E40",
    "category": "camera",
    "models": [
      "T8131"
    ],
    "deviceType": 33,
    "status": "ready_to_test",
    "handler": "camera"
  },
  {
    "id": "t8401",
    "name": "Indoor Cam 1080p (Solo IndoorCam C22)",
    "category": "camera",
    "models": [
      "T8401"
    ],
    "deviceType": 34,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8411",
    "name": "Indoor Cam 1080p Pan & Tilt (Solo IndoorCam P22)",
    "category": "camera",
    "models": [
      "T8411"
    ],
    "deviceType": 35,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8422",
    "name": "Floodlight Cam E 2K",
    "category": "camera",
    "models": [
      "T8422"
    ],
    "deviceType": 37,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8423",
    "name": "Floodlight Cam 2 Pro (S330)",
    "category": "camera",
    "models": [
      "T8423"
    ],
    "deviceType": 38,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8424",
    "name": "Floodlight Cam 2 / E221",
    "category": "camera",
    "models": [
      "T8424"
    ],
    "deviceType": 39,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8440",
    "name": "Outdoor Cam 1080p (no light)",
    "category": "camera",
    "models": [
      "T8440"
    ],
    "deviceType": 44,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8441",
    "name": "Outdoor Cam Pro / E220 (Solo OutdoorCam C24)",
    "category": "camera",
    "models": [
      "T8441"
    ],
    "deviceType": 45,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8442",
    "name": "Outdoor Cam 1080p (Solo OutdoorCam C22)",
    "category": "camera",
    "models": [
      "T8442"
    ],
    "deviceType": 46,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8425",
    "name": "Floodlight Cam E340",
    "category": "camera",
    "models": [
      "T8425",
      "T8425121"
    ],
    "deviceType": 47,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8170",
    "name": "SoloCam S340",
    "category": "camera",
    "models": [
      "T8170",
      "T81701W1"
    ],
    "deviceType": 48,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8144",
    "name": "eufyCam E40",
    "category": "camera",
    "models": [
      "T8144"
    ],
    "deviceType": 49,
    "status": "ready_to_test",
    "handler": "camera"
  },
  {
    "id": "t8510p",
    "name": "Smart Lock S230",
    "category": "smart_lock",
    "models": [
      "T8510P",
      "T8510111"
    ],
    "deviceType": 51,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8520p",
    "name": "Smart Lock S231",
    "category": "smart_lock",
    "models": [
      "T8520P"
    ],
    "deviceType": 51,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8503",
    "name": "Retrofit Smart Lock E110",
    "category": "smart_lock",
    "models": [
      "T8503",
      "T8503J11",
      "T8503111"
    ],
    "deviceType": 54,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8530",
    "name": "Video Smart Lock S330",
    "category": "smart_lock",
    "models": [
      "T8530",
      "E85301Y1",
      "E8530JY1",
      "E8530TY1"
    ],
    "deviceType": 55,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8504",
    "name": "Retrofit Smart Lock E130",
    "category": "smart_lock",
    "models": [
      "T8504",
      "T8504121"
    ],
    "deviceType": 58,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8122",
    "name": "SoloCam L20",
    "category": "camera",
    "models": [
      "T8122"
    ],
    "deviceType": 60,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8123",
    "name": "SoloCam L40",
    "category": "camera",
    "models": [
      "T8123"
    ],
    "deviceType": 61,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8124",
    "name": "SoloCam S40 / S230 (solar spotlight)",
    "category": "camera",
    "models": [
      "T8124"
    ],
    "deviceType": 62,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8134",
    "name": "SoloCam S220",
    "category": "camera",
    "models": [
      "T8134"
    ],
    "deviceType": 63,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8b00",
    "name": "SoloCam C210",
    "category": "camera",
    "models": [
      "T8B00"
    ],
    "deviceType": 64,
    "status": "ready_to_test",
    "handler": "camera"
  },
  {
    "id": "t8426",
    "name": "Floodlight Camera E30",
    "category": "camera",
    "models": [
      "T8426",
      "T8426121"
    ],
    "deviceType": 87,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8171",
    "name": "SoloCam E30",
    "category": "camera",
    "models": [
      "T8171"
    ],
    "deviceType": 88,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8172",
    "name": "eufyCam S4",
    "category": "camera",
    "models": [
      "T8172",
      "T81721W1"
    ],
    "deviceType": 89,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8790",
    "name": "SmartDrop S300",
    "category": "smart_drop",
    "models": [
      "T8790"
    ],
    "deviceType": 90,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8213",
    "name": "Video Doorbell S330 / Dual (Battery)",
    "category": "doorbell",
    "models": [
      "T8213"
    ],
    "deviceType": 91,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8203",
    "name": "Video Doorbell (Wired) S330 / Dual",
    "category": "doorbell",
    "models": [
      "T8203"
    ],
    "deviceType": 93,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8214",
    "name": "Video Doorbell E340 (Battery)",
    "category": "doorbell",
    "models": [
      "T8214",
      "T8214111"
    ],
    "deviceType": 94,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8224",
    "name": "Video Doorbell C30",
    "category": "doorbell",
    "models": [
      "T8224"
    ],
    "deviceType": 95,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8223",
    "name": "Video Doorbell C31",
    "category": "doorbell",
    "models": [
      "T8223"
    ],
    "deviceType": 96,
    "status": "ready_to_test",
    "handler": "camera"
  },
  {
    "id": "t8224",
    "name": "Video Doorbell C30",
    "category": "doorbell",
    "models": [
      "T8224"
    ],
    "deviceType": 96,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8173",
    "name": "SoloCam E42",
    "category": "camera",
    "models": [
      "T8173"
    ],
    "deviceType": 98,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8414",
    "name": "Indoor Cam Mini 2K",
    "category": "camera",
    "models": [
      "T8414"
    ],
    "deviceType": 100,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8416",
    "name": "Indoor Cam S350",
    "category": "camera",
    "models": [
      "T8416",
      "T8416121"
    ],
    "deviceType": 104,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8417",
    "name": "Indoor Cam E30",
    "category": "camera",
    "models": [
      "T8417",
      "T8417121"
    ],
    "deviceType": 105,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8150",
    "name": "4G LTE Starlight Camera (S230)",
    "category": "camera",
    "models": [
      "T8150",
      "T8151",
      "T8152",
      "T8153"
    ],
    "deviceType": 110,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t86p2",
    "name": "4G LTE Cam S330",
    "category": "camera",
    "models": [
      "T86P2",
      "T86P2121"
    ],
    "deviceType": 111,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t90r0",
    "name": "Indoor Siren E20",
    "category": "siren",
    "models": [
      "T90R0",
      "T90R0121"
    ],
    "deviceType": 123,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t90e0",
    "name": "Entry Sensor E20",
    "category": "security_sensor",
    "models": [
      "T90E0",
      "T90E0121"
    ],
    "deviceType": 126,
    "status": "ready_to_test",
    "handler": "sensor"
  },
  {
    "id": "t90m0",
    "name": "Motion Sensor E20",
    "category": "security_sensor",
    "models": [
      "T90M0",
      "T90M0121"
    ],
    "deviceType": 127,
    "status": "ready_to_test",
    "handler": "sensor"
  },
  {
    "id": "t8453-common",
    "name": "Garage camera (T8453 common id)",
    "category": "camera",
    "models": [
      "T8453"
    ],
    "deviceType": 131,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8452",
    "name": "Garage-Control Cam E110",
    "category": "camera",
    "models": [
      "T8452"
    ],
    "deviceType": 132,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8453-e120",
    "name": "Garage-Control Cam E120",
    "category": "camera",
    "models": [
      "T8453"
    ],
    "deviceType": 133,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t7400",
    "name": "Smart Safe S10",
    "category": "smart_safe",
    "models": [
      "T7400"
    ],
    "deviceType": 140,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t7401",
    "name": "Smart Safe S12",
    "category": "smart_safe",
    "models": [
      "T7401"
    ],
    "deviceType": 141,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t7402",
    "name": "Smart Safe T7402",
    "category": "smart_safe",
    "models": [
      "T7402"
    ],
    "deviceType": 142,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t7403",
    "name": "Smart Safe T7403",
    "category": "smart_safe",
    "models": [
      "T7403"
    ],
    "deviceType": 143,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t84a1",
    "name": "Wired Wall Light Cam S100",
    "category": "camera",
    "models": [
      "T84A1",
      "T84A1311"
    ],
    "deviceType": 151,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t87b0",
    "name": "SmartTrack Link",
    "category": "tracker",
    "models": [
      "T87B0",
      "T87B0011"
    ],
    "deviceType": 157,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t87b2",
    "name": "SmartTrack Card",
    "category": "tracker",
    "models": [
      "T87B2",
      "T87B2011"
    ],
    "deviceType": 159,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t87b4",
    "name": "SmartTrack Link for Android",
    "category": "tracker",
    "models": [
      "T87B4",
      "T87B4N11"
    ],
    "deviceType": 161,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8502",
    "name": "Smart Lock C210",
    "category": "smart_lock",
    "models": [
      "T8502",
      "T8502111"
    ],
    "deviceType": 180,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8506",
    "name": "Smart Lock C220",
    "category": "smart_lock",
    "models": [
      "T8506",
      "T8506111",
      "E8506111"
    ],
    "deviceType": 184,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8531",
    "name": "Video Smart Lock E330",
    "category": "smart_lock",
    "models": [
      "T8531",
      "E8531JY1"
    ],
    "deviceType": 189,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t85l0",
    "name": "Lever Smart Lock C33",
    "category": "smart_lock",
    "models": [
      "T85L0",
      "T85L0111"
    ],
    "deviceType": 201,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t85d0",
    "name": "Smart Lock C30",
    "category": "smart_lock",
    "models": [
      "T85D0",
      "T85D0C",
      "T85D0111",
      "E85D0111"
    ],
    "deviceType": 202,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t85v0",
    "name": "FamiLock S3 / S3 Max",
    "category": "smart_lock",
    "models": [
      "T85V0",
      "T85V01Y1",
      "T85V0C",
      "E85V0",
      "E85V0JY1",
      "T85V0JY1"
    ],
    "deviceType": 203,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t85p0",
    "name": "FamiLock E34",
    "category": "smart_lock",
    "models": [
      "T85P0",
      "T85P0111"
    ],
    "deviceType": 209,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t85l1",
    "name": "Smart Lock C32",
    "category": "smart_lock",
    "models": [
      "T85L1",
      "T85L1111",
      "T85L1114"
    ],
    "deviceType": 211,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8n00",
    "name": "NVR S4 Max",
    "category": "nvr",
    "models": [
      "T8N00",
      "T8N00141"
    ],
    "deviceType": 300,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8e00",
    "name": "PoE Bullet-PTZ Cam S4",
    "category": "camera",
    "models": [
      "T8E00",
      "T8E00121"
    ],
    "deviceType": 301,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8p10",
    "name": "PoE Cam E41 (turret)",
    "category": "camera",
    "models": [
      "T8P10",
      "T8P10121"
    ],
    "deviceType": 303,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t84a0",
    "name": "Solar Wall Light Cam S120",
    "category": "camera",
    "models": [
      "T84A0",
      "T81A0",
      "T81A0111"
    ],
    "deviceType": 10005,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8w11c-original",
    "name": "Indoor Cam C220 (T8W11C, original)",
    "category": "camera",
    "models": [
      "T8W11C",
      "T8W11"
    ],
    "deviceType": 10008,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8419",
    "name": "Indoor Cam C210",
    "category": "camera",
    "models": [
      "T8419"
    ],
    "deviceType": 10009,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8w11c-v2",
    "name": "Indoor Cam C220 (T8W11C, v2)",
    "category": "camera",
    "models": [
      "T8W11C",
      "T8W11"
    ],
    "deviceType": 10010,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8419n",
    "name": "Indoor Cam C220 (T8419N, v3)",
    "category": "camera",
    "models": [
      "T8419N"
    ],
    "deviceType": 10011,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t817l",
    "name": "Wired Cam C31",
    "category": "camera",
    "models": [
      "T817L",
      "T817L121"
    ],
    "deviceType": 10031,
    "status": "supported",
    "handler": "camera"
  },
  {
    "id": "t8110e",
    "name": "eufyCam C34",
    "category": "camera",
    "models": [
      "T8110E"
    ],
    "deviceType": 10034,
    "status": "recognised",
    "handler": null
  },
  {
    "id": "t8110",
    "name": "eufyCam C35",
    "category": "camera",
    "models": [
      "T8110"
    ],
    "deviceType": 10035,
    "status": "ready_to_test",
    "handler": "camera"
  },
  {
    "id": "t814x",
    "name": "eufyCam C37",
    "category": "camera",
    "models": [
      "T814X",
      "T814XS"
    ],
    "deviceType": 10037,
    "status": "supported",
    "handler": "camera"
  }
] as const;

/** Device types admitted to the implemented camera handler. */
export const GENERATED_CAMERA_DEVICE_TYPES: ReadonlySet<number> = new Set([3,5,7,8,9,14,15,19,23,26,30,31,32,33,38,45,47,48,49,61,62,63,64,87,88,91,94,96,104,105,151,203,10005,10009,10031,10035,10037]);

/** Device types admitted to the implemented standalone-sensor handler. */
export const GENERATED_SENSOR_DEVICE_TYPES: ReadonlySet<number> = new Set([2,10,20,126,127]);

/** Known HomeBase types evaluated by the HomeBase capability handler. */
export const GENERATED_HOMEBASE_DEVICE_TYPES: ReadonlySet<number> = new Set([0,18,27,28]);

/** Known camera-like types, including recognised devices not yet admitted. */
export const GENERATED_KNOWN_CAMERA_DEVICE_TYPES: ReadonlySet<number> = new Set([1,3,4,5,7,8,9,14,15,16,19,23,24,26,30,31,32,33,34,35,37,38,39,44,45,46,47,48,49,60,61,62,63,64,87,88,89,91,93,94,95,96,98,100,104,105,110,111,131,132,133,151,301,303,10005,10008,10009,10010,10011,10031,10034,10035,10037]);

/** Known non-camera types that must not enter camera review or admission. */
export const GENERATED_NON_CAMERA_DEVICE_TYPES: ReadonlySet<number> = new Set([0,2,10,11,18,20,25,27,28,51,54,55,58,90,123,126,127,140,141,142,143,157,159,161,180,184,189,201,202,203,209,211,300]);
