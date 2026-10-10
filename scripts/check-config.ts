/** Startup preflight: configuration only, no network or child agent. */
import { loadConfig } from "../src/config.js";
loadConfig();
console.log("Configuration valid.");
