const MODEL_NAME = 'gemini-2.5-flash';

export const callGeminiAPI = async (payload: object, apiKey: string): Promise<any> => {
  const key = apiKey.trim();
  if (!key) throw new Error('Gemini APIキーが未設定です。設定画面からAPIキーを保存してください。');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${key}`;
  const retries = 3;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (response.ok) return data;
      if (i === retries - 1) {
        const msg = data?.error?.message || text || 'Unknown Gemini API error';
        throw new Error(`API Error ${response.status}: ${msg}`);
      }
    } catch (e) {
      if (i === retries - 1) throw e;
    }
    await new Promise((res) => setTimeout(res, Math.pow(2, i) * 1000));
  }
};

export const ocrImageWithGemini = async (base64Image: string, apiKey: string): Promise<string> => {
  const payload = {
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: base64Image,
            },
          },
          {
            text: '画像内のテキストをすべて読み取り、そのまま出力してください。テキストが見当たらない場合は「テキストなし」と返してください。',
          },
        ],
      },
    ],
  };
  const data = await callGeminiAPI(payload, apiKey);
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
};
