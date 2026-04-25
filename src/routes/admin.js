import express from "express";
import { supabase } from "../services/supabase.js";

const router = express.Router();

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return date.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo"
  });
}

router.get("/admin", async (req, res) => {
  try {
    const selectedPhone = String(req.query.phone || "").trim();

    const { data: allMessages, error } = await supabase
      .from("messages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(300);

    if (error) {
      return res.send("Erro ao buscar mensagens: " + error.message);
    }

    const conversationsMap = new Map();

    for (const msg of allMessages || []) {
      const phone = msg.user_phone || "sem telefone";

      if (!conversationsMap.has(phone)) {
        conversationsMap.set(phone, {
          phone,
          lastMessage: msg.message || "",
          lastRole: msg.role || "",
          lastDate: msg.created_at || "",
          count: 0
        });
      }

      conversationsMap.get(phone).count += 1;
    }

    const conversations = Array.from(conversationsMap.values());

    const currentPhone = selectedPhone || conversations[0]?.phone || "";

    const selectedMessages = (allMessages || [])
      .filter((msg) => String(msg.user_phone || "") === currentPhone)
      .reverse();

    const sidebarHtml = conversations
      .map((conv) => {
        const active = conv.phone === currentPhone ? "active" : "";
        return `
          <a class="conversation ${active}" href="/admin?phone=${encodeURIComponent(conv.phone)}">
            <div class="phone">${escapeHtml(conv.phone)}</div>
            <div class="preview">${escapeHtml(conv.lastMessage)}</div>
            <div class="meta">
              <span>${escapeHtml(conv.lastRole)}</span>
              <span>${escapeHtml(formatDate(conv.lastDate))}</span>
            </div>
          </a>
        `;
      })
      .join("");

    const chatHtml = selectedMessages
      .map((msg) => {
        const isAssistant = msg.role === "assistant";
        const bubbleClass = isAssistant ? "assistant" : "user";

        return `
          <div class="message-row ${bubbleClass}">
            <div class="bubble">
              <div class="text">${escapeHtml(msg.message)}</div>
              <div class="time">${escapeHtml(formatDate(msg.created_at))}</div>
            </div>
          </div>
        `;
      })
      .join("");

    res.send(`
      <!doctype html>
      <html lang="pt-BR">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Painel TRIVIA</title>
          <style>
            * {
              box-sizing: border-box;
            }

            body {
              margin: 0;
              font-family: Arial, sans-serif;
              background: #111b21;
              color: #e9edef;
            }

            .app {
              display: grid;
              grid-template-columns: 360px 1fr;
              height: 100vh;
            }

            .sidebar {
              border-right: 1px solid #2a3942;
              background: #111b21;
              overflow-y: auto;
            }

            .sidebar-header {
              padding: 18px;
              background: #202c33;
              font-size: 22px;
              font-weight: bold;
            }

            .conversation {
              display: block;
              padding: 14px 16px;
              text-decoration: none;
              color: #e9edef;
              border-bottom: 1px solid #222d34;
            }

            .conversation:hover,
            .conversation.active {
              background: #2a3942;
            }

            .phone {
              font-size: 16px;
              font-weight: bold;
              margin-bottom: 6px;
            }

            .preview {
              color: #aebac1;
              font-size: 14px;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }

            .meta {
              margin-top: 6px;
              color: #8696a0;
              display: flex;
              justify-content: space-between;
              gap: 8px;
              font-size: 12px;
            }

            .chat {
              display: flex;
              flex-direction: column;
              height: 100vh;
              background: #0b141a;
            }

            .chat-header {
              background: #202c33;
              padding: 18px;
              font-size: 18px;
              font-weight: bold;
              border-bottom: 1px solid #2a3942;
            }

            .messages {
              flex: 1;
              padding: 22px;
              overflow-y: auto;
            }

            .message-row {
              display: flex;
              margin-bottom: 12px;
            }

            .message-row.user {
              justify-content: flex-end;
            }

            .message-row.assistant {
              justify-content: flex-start;
            }

            .bubble {
              max-width: 68%;
              padding: 10px 12px;
              border-radius: 10px;
              line-height: 1.4;
              white-space: pre-wrap;
              word-wrap: break-word;
            }

            .message-row.user .bubble {
              background: #005c4b;
            }

            .message-row.assistant .bubble {
              background: #202c33;
            }

            .time {
              margin-top: 6px;
              font-size: 11px;
              color: #aebac1;
              text-align: right;
            }

            .empty {
              padding: 40px;
              color: #aebac1;
            }

            @media (max-width: 800px) {
              .app {
                grid-template-columns: 1fr;
              }

              .sidebar {
                height: 40vh;
              }

              .chat {
                height: 60vh;
              }
            }
          </style>
        </head>
        <body>
          <div class="app">
            <aside class="sidebar">
              <div class="sidebar-header">Painel TRIVIA</div>
              ${sidebarHtml || `<div class="empty">Nenhuma conversa encontrada.</div>`}
            </aside>

            <main class="chat">
              <div class="chat-header">
                Conversa: ${escapeHtml(currentPhone || "nenhuma")}
              </div>

              <div class="messages">
                ${chatHtml || `<div class="empty">Nenhuma mensagem nesta conversa.</div>`}
              </div>
            </main>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.send("Erro geral: " + err.message);
  }
});

export default router;
