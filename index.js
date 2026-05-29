require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Discord 클라이언트 설정
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ],
});

// Gemini AI 설정
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

// 봇 준비 완료
client.once('ready', () => {
  console.log(`✅ 봇이 로그인되었습니다: ${client.user.tag}`);
});

// 메시지 처리
client.on('messageCreate', async (message) => {
  // 봇 자신의 메시지는 무시
  if (message.author.bot) return;

  // 봇 멘션 또는 특정 명령어로 시작하는 메시지만 처리
  if (!message.mentions.has(client.user) && !message.content.startsWith('!ai')) return;

  // 멘션 제거하고 질문 추출
  const question = message.content
    .replace(`<@${client.user.id}>`, '')
    .replace('!ai', '')
    .trim();

  if (!question) {
    return message.reply('질문을 입력해주세요!');
  }

  try {
    // 타이핑 표시
    await message.channel.sendTyping();

    // Gemini AI에게 질문
    const result = await model.generateContent(question);
    const response = result.response.text();

    // 응답이 2000자를 넘으면 나눠서 전송
    if (response.length > 2000) {
      const chunks = response.match(/[\s\S]{1,2000}/g);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      await message.reply(response);
    }
  } catch (error) {
    console.error('오류 발생:', error);
    message.reply('❌ 오류가 발생했습니다. 다시 시도해주세요.');
  }
});

// 봇 로그인
client.login(process.env.DISCORD_TOKEN);