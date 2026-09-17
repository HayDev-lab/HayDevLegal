import ZAI from "z-ai-web-dev-sdk";
const t0 = Date.now();
try {
  const zai = await ZAI.create();
  const r = (await zai.chat.completions.create({
    messages: [{ role: "user", content: "Պատասխանիր միայն՝ OK" }],
    thinking: { type: "disabled" },
    max_tokens: 10,
  })) as any;
  console.log("chat OK", Date.now() - t0, "ms:", r.choices?.[0]?.message?.content?.slice(0, 20));
} catch (e) {
  console.log("chat FAILED", Date.now() - t0, "ms:", (e as Error).message.slice(0, 80));
}
