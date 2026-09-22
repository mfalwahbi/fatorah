export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { base64Data, mimeType } = req.body;
    if (!base64Data || !mimeType) {
      return res.status(400).json({ error: 'بيانات ناقصة' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    const SAMBANOVA_API_KEY = process.env.SAMBANOVA_API_KEY;

    const EXTRACTION_PROMPT = "استخرج البيانات كـ JSON فقط وبدون أي نصوص إضافية أو علامات Markdown. الحقول: store, amount, category (استنتج تصنيف دقيق بكلمة واحدة مثل: إلكترونيات، قهوة، سيارات، مطاعم), items, date (YYYY-MM-DD), warranty_months (إذا كانت الفاتورة لأجهزة إلكترونية أو كمبيوتر استخرج أو استنتج مدة الضمان بالأشهر، وإذا لم تكن إلكترونيات أو لا يوجد ضمان ضع 0)";

    function parseAiJson(rawText) {
      const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
      return JSON.parse(cleaned);
    }

    async function analyzeWithGemini() {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: EXTRACTION_PROMPT },
            { inline_data: { mime_type: mimeType, data: base64Data } }
          ]}],
          generationConfig: { response_mime_type: "application/json" }
        })
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error?.message || "Gemini فشل");
      const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error("Gemini ما رجع نتيجة");
      return parseAiJson(rawText);
    }

    async function analyzeWithGroq() {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({
          model: "meta-llama/llama-4-scout-17b-16e-instruct", // تم التأكد من أن هذا النموذج صحيح[reference:2]
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: [
            { type: "text", text: EXTRACTION_PROMPT },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Data}` } }
          ]}]
        })
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error?.message || "Groq فشل");
      const rawText = result.choices?.[0]?.message?.content;
      if (!rawText) throw new Error("Groq ما رجع نتيجة");
      return parseAiJson(rawText);
    }

    async function analyzeWithSambaNova() {
      const res = await fetch("https://api.sambanova.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SAMBANOVA_API_KEY}` },
        body: JSON.stringify({
          model: "MiniMax-M3", // ✅ تم تحديث اسم النموذج إلى النموذج الصحيح[reference:3]
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: [
            { type: "text", text: EXTRACTION_PROMPT },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Data}` } }
          ]}]
        })
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error?.message || "SambaNova فشل");
      const rawText = result.choices?.[0]?.message?.content;
      if (!rawText) throw new Error("SambaNova ما رجع نتيجة");
      return parseAiJson(rawText);
    }

    const providers = [
      { name: "Gemini", fn: analyzeWithGemini },
      { name: "Groq", fn: analyzeWithGroq },
      { name: "SambaNova", fn: analyzeWithSambaNova }
    ];

    let parsed = null;
    let lastError = null;

    for (const provider of providers) {
      try {
        parsed = await provider.fn();
        break;
      } catch (err) {
        console.warn(`فشل ${provider.name}:`, err.message);
        lastError = err;
      }
    }

    if (!parsed) return res.status(500).json({ error: lastError?.message || "كل المزودين فشلوا" });
    return res.status(200).json(parsed);

  } catch (error) {
    return res.status(500).json({ error: error.message || "خطأ في الخادم" });
  }
}