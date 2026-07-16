import { defineConfig } from "vite";

export default defineConfig({
  // The device serves your app from a folder, not a site root, so asset URLs
  // must be relative. Do not remove this: with the default base ("/") the app
  // white-screens on device.
  base: "./",
});
