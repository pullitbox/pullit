import { test } from "node:test";
import assert from "node:assert/strict";
import { oauthHeader } from "../src/x.ts";

// Reference values from X's "Creating a signature" documentation.
test("OAuth 1.0a signature matches X docs example", async () => {
  const c = {
    apiKey: "xvz1evFS4wEEPTGEFPHBog",
    apiSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    accessSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  };
  const url = "https://api.twitter.com/1.1/statuses/update.json?include_entities=true&status=" +
    encodeURIComponent("Hello Ladies + Gentlemen, a signed OAuth request!").replace(/!/g, "%21");
  const h = await oauthHeader("POST", url, c, "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", "1318622958");
  assert.match(h, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
});
