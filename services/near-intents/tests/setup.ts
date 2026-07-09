// Default env for tests. Unit tests never hit the network — they inject
// fetchImpl (and a readBalance stub) — so point the API base somewhere
// unroutable to make any accidental live call fail loudly.
process.env.ONECLICK_API_URL = "https://oneclick.invalid";
process.env.NEAR_INTENT_API_KEY = "";
