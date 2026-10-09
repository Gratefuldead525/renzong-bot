import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========== 配置（部署后填入） ==========
const APP_KEY = process.env.APP_KEY || 'YOUR_APP_KEY';
const APP_SECRET = process.env.APP_SECRET || 'YOUR_APP_SECRET';
const BASE_ID = 'YndMj49yWjlAYoxjtDXMGENYJ3pmz5aA';

// 表 ID 映射
const TABLES = {
  drama: 'tB7knsJ',   // 剧集
  variety: 'I2ukBWA', // 综艺
  doc: '3iRd702',     // 人文&纪录片
};

// 字段 ID
const FIELDS = {
  project: '0yjvNcD',
  status: 'ZcZAQtm',
  note: 'o7gZdeK',
  date: 'jl22mv5',
};

// ========== 钉钉 API 工具函数 ==========

// 获取 access_token
async function getAccessToken() {
  const url = `https://oapi.dingtalk.com/gettoken?appkey=${APP_KEY}&appsecret=${APP_SECRET}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.errcode !== 0) throw new Error(`获取token失败: ${data.errmsg}`);
  return data.access_token;
}

// 写入 AI 表格记录
async function createRecord(tableId, projectName, workContent, sender, groupName) {
  const token = await getAccessToken();
  const today = new Date().toISOString().slice(0, 10);
  const noteText = `【任总机器人归档·${groupName || '群聊'}·${today}】\n${workContent}\n消息来源：${sender}`;

  const url = `https://api.dingtalk.com/v1.0/aitable/tables/${tableId}/records`;
  const body = {
    records: [{
      cells: {
        [FIELDS.project]: projectName,
        [FIELDS.status]: '待排期',
        [FIELDS.note]: noteText,
        [FIELDS.date]: today,
      }
    }]
  };

  const resp = await fetch(`${url}?baseId=${BASE_ID}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// 查询已有记录（去重）
async function queryRecords(tableId, keyword) {
  const token = await getAccessToken();
  const url = `https://api.dingtalk.com/v1.0/aitable/tables/${tableId}/records/search?baseId=${BASE_ID}`;
  const body = {
    filter: {
      conjunction: 'and',
      conditions: [{
        fieldId: FIELDS.project,
        operator: 'contains',
        value: [keyword],
      }]
    }
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// 更新记录备注
async function updateRecord(tableId, recordId, note) {
  const token = await getAccessToken();
  const url = `https://api.dingtalk.com/v1.0/aitable/tables/${tableId}/records`;
  const body = {
    records: [{
      recordId: recordId,
      cells: { [FIELDS.note]: note }
    }]
  };
  const resp = await fetch(`${url}?baseId=${BASE_ID}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// ========== AI 分类逻辑 ==========

function classifyMessage(text, sender, conversationId) {
  // 从消息中提取项目名（书名号内）
  const projectMatch = text.match(/《([^》]+)》/);
  const projectName = projectMatch ? `《${projectMatch[1]}》` : null;

  // 提取工作内容（去掉"任总"和项目名后的剩余文本）
  let workContent = text
    .replace(/@?任总/, '')
    .replace(/《[^》]+》/g, '')
    .trim();
  
  if (!workContent) workContent = '（未提取到具体工作内容）';

  // 分类逻辑
  let category = 'drama'; // 默认剧集
  const lowerText = text.toLowerCase();

  if (lowerText.match(/综艺|选秀|真人秀|竞演|开播|录制|选手|嘉宾/)) {
    category = 'variety';
  } else if (lowerText.match(/人文|纪录|纪录片|非遗|昆仑|圆桌|转机/)) {
    category = 'doc';
  } else if (lowerText.match(/剧|剧集|剧综|宣发|海报|修图|拍摄|logo|片方/)) {
    category = 'drama';
  }

  // 根据来源群判断
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
    const { msgtype, text, senderNick, conversationId, chatbotUserId } = req.body;
    
    // 获取消息文本
    let messageText = '';
    if (msgtype === 'text' && text && text.content) {
      messageText = text.content;
    } else {
      // 非文本消息，忽略
      return res.json({ msgtype: 'text', text: { content: '任总只处理文本消息哦~' } });
    }

    // 清理 @任总 的前缀
    messageText = messageText.replace(/@任总\s*/g, '').trim();

    if (!messageText) {
      return res.json({ msgtype: 'text', text: { content: '请告诉任总项目名称和工作内容，格式：任总 《项目名》工作内容描述' } });
    }

    // 解析和分类
    const { projectName, workContent, category } = classifyMessage(messageText, senderNick, conversationId);
    const tableId = TABLES[category];
    const categoryName = { drama: '剧集', variety: '综艺', doc: '人文&纪录片' }[category];

    if (!projectName) {
      return res.json({
        msgtype: 'text',
        text: { content: `⚠️ 任总未识别到项目名称，请用书名号包裹，例如：任总 《项目名》工作内容` }
      });
    }

    // 去重检查
    let action = '新增';
    try {
      const existing = await queryRecords(tableId, projectName.replace(/[《》]/g, ''));
      if (existing.data && existing.data.records && existing.data.records.length > 0) {
        // 已有项目，更新备注
        const recordId = existing.data.records[0].recordId;
        const today = new Date().toISOString().slice(0, 10);
        const noteText = `【任总机器人归档·${today}】\n${workContent}\n消息来源：${senderNick}`;
        await updateRecord(tableId, recordId, noteText);
        action = '更新';
      } else {
        // 新项目，创建记录
        await createRecord(tableId, projectName, workContent, senderNick, '钉钉群聊');
      }
    } catch (e) {
      // API 调用失败，尝试直接创建
      await createRecord(tableId, projectName, workContent, senderNick, '钉钉群聊');
    }

    // 回复确认
    const replyText = `✅ 任总已${action}：${projectName}\n📝 工作内容：${workContent.slice(0, 100)}\n📊 已归档到${categoryName}表\n🔗 查看表格：https://alidocs.dingtalk.com/i/nodes/${BASE_ID}`;

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

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', bot: '任总', time: new Date().toISOString() });
});

// 根路径
app.get('/', (req, res) => {
  res.json({ 
    name: '任总机器人', 
    status: 'running',
    endpoints: { webhook: 'POST /webhook', health: 'GET /health' }
  });
});

const PORT = process.env.PORT || 8081;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`任总机器人已启动: http://${HOST}:${PORT}`);
});
