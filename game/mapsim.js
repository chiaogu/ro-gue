// The map panel's worker (viewer/mapsim.js), started from here: a worker is served by the service worker whose
// scope its own URL is in, so one started at ../viewer/ is not sw.js's (offline, it did not load) but the
// viewer's, if any. This one is in /game/, and what it imports goes through sw.js.
import '../viewer/mapsim.js';
