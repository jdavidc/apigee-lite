// Builds the Open-Meteo request from validated variables only.
// The client query string is never forwarded to the backend (allow-list approach).

var CURRENT_FIELDS = "temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,weather_code";
var DAILY_FIELDS = "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,weather_code";

var isForecast = context.getVariable("proxy.pathsuffix") === "/forecast";

var query = [
  "latitude=" + context.getVariable("jobsite.latitude"),
  "longitude=" + context.getVariable("jobsite.longitude"),
  "timezone=auto",
  "wind_speed_unit=kmh"
];

if (isForecast) {
  query.push("daily=" + DAILY_FIELDS);
  query.push("forecast_days=" + context.getVariable("jobsite.forecastDays"));
} else {
  query.push("current=" + CURRENT_FIELDS);
}

context.setVariable("target.copy.pathsuffix", false);
context.setVariable("target.copy.queryparams", false);
context.setVariable("target.url", context.getVariable("target.url") + "/forecast?" + query.join("&"));
context.setVariable("request.header.Accept", "application/json");
