import express from 'express';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========== 配置 ==========
const BASE_ID = 'YndMj49yWjlAYoxjtDXMGENYJ3pmz5aA';

const TABLES = {
  drama: 'tB7knsJ',
  variety: 'I2ukBWA',
  doc: '3iRd702',
};

const FIELDS = {
  project: '0yjvNcD',
  status: 'ZcZAQtm',
  note: 'o7gZdeK',
  date: 'jl22mv5',
};

// ========== 消息队列 ==========
const messageQueue = [];

// ========== AI 分类逻辑 ==========

function classifyMessage(text, sender, conversationId) {
  const projectMatch = text.match(/《([^》]+)》/);
  const projectName = projectMatch ? `《${projectMatch[1]}》` : null;

  let workContent = text
    .replace(/@?任总/, '')
    .replace(/《[^》]+》/g, '')
    .trim();
  
  if (!workContent) workContent = '（未提取到具体工作内容）';

  let category = 'drama';
  const lowerText = text.toLowerCase();

  if (lowerText.match(/综艺|选秀|真人秀|竞演|开播|录制|选手|嘉宾/)) {
    category = 'variety';
  } else if (lowerText.match(/人文|纪录|纪录片|非遗|昆仑|圆桌|转机/)) {
    category = 'doc';
  } else if (lowerText.match(/剧|剧集|剧综|宣发|海报|修图|拍摄|logo|片方/)) {
    category = 'drama';
  }

  const knownGroups = {
    'cidMqdKyEGgV/otmRHhIkArVw==': 'drama',
    'cidEB7LLaVVjQmNUJh7ISF73g==': 'variety',
  };
  if (conversationId && knownGroups[conversationId]) {
    category = knownGroups[conversationId];
  }

  return { projectName, workContent, category };
}

// ========== Webhook 接收端点 ==========

app.post('/webhook', async (req, res) => {
  try {
    const { msgtype, text, senderNick, conversationId } = req.body;
    
    let messageText = '';
    if (msgtype === 'text' && text && text.content) {
      messageText = text.content;
    } else {
      return res.json({ msgtype: 'text', text: { content: '任总只处理文本消息哦~' } });
    }

    messageText = messageText.replace(/@任总\s*/g, '').trim();

    if (!messageText) {
      return res.json({ msgtype: 'text', text: { content: '请告诉任总项目名称和工作内容，格式：任总 《项目名》工作内容描述' } });
    }

    const { projectName, workContent, category } = classifyMessage(messageText, senderNick || '未知', conversationId);
    const tableId = TABLES[category];
    const categoryName = { drama: '剧集', variety: '综艺', doc: '人文&纪录片' }[category];

    if (!projectName) {
      return res.json({
        msgtype: 'text',
        text: { content: '⚠️ 任总未识别到项目名称，请用书名号包裹，例如：任总 《项目名》工作内容' }
      });
    }

    // 存入消息队列
    const today = new Date().toLocaleDateString('zh-CN', {timeZone: 'Asia/Shanghai'}).replace(/\//g, '-');
    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    messageQueue.push({
      id: msgId,
      projectName,
      workContent,
      category,
      categoryName,
      tableId,
      sender: senderNick || '未知',
      conversationId: conversationId || '',
      rawText: messageText,
      timestamp: new Date().toISOString(),
      processed: false,
      note: `【任总机器人归档·${today}】\n${workContent}\n消息来源：${senderNick || '未知'}`,
      date: today,
    });

    const replyText = `✅ 任总已收到：${projectName}\n📝 工作内容：${workContent.slice(0, 100)}\n📊 将归档到${categoryName}表\n⏳ 正在排队写入，请稍后查看表格`;

    return res.json({
      msgtype: 'text',
      text: { content: replyText }
    });

  } catch (error) {
    console.error('处理失败:', error);
    return res.json({
      msgtype: 'text',
      text: { content: `❌ 任总处理失败：${error.message}，请稍后重试` }
    });
  }
});

// ========== 消息队列提取接口（供 DWS 定时任务调用）==========
app.get('/messages', (req, res) => {
  const unprocessed = messageQueue.filter(m => !m.processed);
  res.json({ 
    count: unprocessed.length,
    total: messageQueue.length,
    messages: unprocessed 
  });
});

app.post('/messages/processed', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.json({ error: 'ids must be an array' });
  let count = 0;
  ids.forEach(id => {
    const msg = messageQueue.find(m => m.id === id);
    if (msg) { msg.processed = true; count++; }
  });
  res.json({ processed: count });
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    bot: '任总', 
    time: new Date().toISOString(),
    queueSize: messageQueue.filter(m => !m.processed).length 
  });
});

app.get('/', (req, res) => {
  res.json({ 
    name: '任总机器人', 
    status: 'running',
    endpoints: { 
      webhook: 'POST /webhook', 
      messages: 'GET /messages',
      processed: 'POST /messages/processed',
      health: 'GET /health' 
    }
  });
});

const PORT = process.env.PORT || 8081;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`任总机器人已启动: http://${HOST}:${PORT}`);
});
