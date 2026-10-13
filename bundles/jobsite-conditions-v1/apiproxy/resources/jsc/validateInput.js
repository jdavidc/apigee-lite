// Validates and normalizes the query parameters extracted by EV-Coordinates.
// On failure sets jobsite.validation.error (RF-BadRequest runs on that condition).
// Coordinates are rounded to 2 decimals (~1 km) so nearby requests share a cache entry.

function isNumber(value) {
  return value !== null && value !== undefined && value !== "" && !isNaN(Number(value));
}

function fail(message) {
  context.setVariable("jobsite.validation.error", message);
}

var lat = context.getVariable("jobsite.lat");
var lon = context.getVariable("jobsite.lon");
var days = context.getVariable("jobsite.days");
var isForecast = context.getVariable("proxy.pathsuffix") === "/forecast";

if (!isNumber(lat) || !isNumber(lon)) {
  fail("Query parameters lat and lon are required and must be numbers");
} else if (Number(lat) < -90 || Number(lat) > 90) {
  fail("lat must be between -90 and 90");
} else if (Number(lon) < -180 || Number(lon) > 180) {
  fail("lon must be between -180 and 180");
} else if (isForecast && days !== null && days !== undefined && !/^[1-7]$/.test(String(days))) {
  fail("days must be an integer between 1 and 7");
} else {
  context.setVariable("jobsite.latitude", Number(lat).toFixed(2));
  context.setVariable("jobsite.longitude", Number(lon).toFixed(2));
  context.setVariable("jobsite.forecastDays", isForecast ? String(days || 3) : "0");
}
