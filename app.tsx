import { definePluginApp } from "@get-bb/plugin-sdk/app";
import dictionary from "./dictionary.json";
import { mountRussian } from "./localize";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "russian-interface",
    mount: ({ signal }) => mountRussian(document, dictionary, signal),
  });
});
