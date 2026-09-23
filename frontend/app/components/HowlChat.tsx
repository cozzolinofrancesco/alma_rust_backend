"use client";

import React, { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FaExpand, FaCompress, FaTimes } from "react-icons/fa";
import type { GroundingChunk } from "@/app/lib/gemini";
import "../styles/HowlChat.css";

interface HowlChatProps {
  initialPrompt?: string;
  onClose: () => void;
}

interface ChatEntry {
  role: "user" | "bot";
  content: string;
  sources?: GroundingChunk[];
  reasoning?: string | null;
}

const HowlChat: React.FC<HowlChatProps> = ({
  initialPrompt = "",
  onClose,
}) => {
  const [finalPrompt, setFinalPrompt] = useState(initialPrompt);
  const [messages, setMessages]         = useState<ChatEntry[]>([]);
  const [inputValue, setInputValue]     = useState("");
  const [isLoading, setIsLoading]       = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, []);

  useEffect(() => {
    if (!initialPrompt) {
      fetch("/api/documentation?file=guides/user-guides/comprehensive-user-guide.md")
        .then((res) => res.text())
        .then((text) => {
          const contextualPrompt = `You are ALMA Assistant. Use the following comprehensive documentation as your primary knowledge base to answer user questions about the ALMA platform:

${text}

Instructions:
- Answer questions primarily based on the above ALMA documentation
- If the question is not about ALMA, answer based on your general knowledge
- Be helpful, accurate, and reference specific sections from the documentation when relevant
- If users ask about features not covered in the documentation, let them know and provide general guidance

User Question: `;
          setFinalPrompt(contextualPrompt);
        })
        .catch((err) => {
          console.error("Failed to load documentation:", err);
          fetch("/about.txt")
            .then((res) => res.text())
            .then((text) => setFinalPrompt(text))
            .catch(() => setFinalPrompt(""));
        });
    }
  }, [initialPrompt]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = inputValue.trim();
    if (!text) return;

    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInputValue("");
    setIsLoading(true);

    const combined = finalPrompt
      ? `${finalPrompt}\n\n${text}`
      : text;

    console.log("📤 Sending to API with documentation context:", combined.length > 500 ? combined.substring(0, 500) + "..." : combined);

    const apiMessages = [{ role: "user" as const, text: combined }];

    try {
      const res = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages, new_chat: false }),
      });
      const data = await res.json();
      const bot  = data.response?.trim() || "No response.";
      const sources: GroundingChunk[] = Array.isArray(data.sources) ? data.sources : [];
      const reasoning: string | null = typeof data.reasoning === "string" ? data.reasoning : null;
      setMessages((prev) => [...prev, { role: "bot", content: bot, sources, reasoning }]);
    } catch {
      setMessages((prev) => [...prev, { role: "bot", content: "Error connecting to Gemini." }]);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleFullscreen = () => setIsFullscreen((f) => !f);

  return (
    <div className={`howl-chat-wrapper ${isFullscreen ? "fullscreen" : ""}`}>
      <div className="howl-chat">
        <div className="howl-chat-header">
          <span>Chat with Alma</span>
          <div className="header-controls">
            <button
              className="icon-button"
              onClick={toggleFullscreen}
              title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <FaCompress /> : <FaExpand />}
            </button>
            <button className="icon-button" onClick={onClose} title="Close">
              <FaTimes />
            </button>
          </div>
        </div>

        <div className="howl-chat-body">
          {messages.length > 0 ? (
            messages.map((msg, idx) => {
              const isUser = msg.role === "user";
              return (
                <div
                  key={idx}
                  className={`chat-message ${isUser ? "user" : "bot"}`}
                >
                  {!isUser && msg.reasoning && (
                    <details className="chat-reasoning">
                      <summary className="chat-reasoning-summary">Show reasoning</summary>
                      <div className="chat-reasoning-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {msg.reasoning}
                        </ReactMarkdown>
                      </div>
                    </details>
                  )}
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="chat-sources">
                      <p className="chat-sources-title">Sources</p>
                      <ul className="chat-sources-list">
                        {msg.sources.map((src, i) => (
                          <li key={i} className="chat-source">
                            {src.uri ? (
                              <a href={src.uri} target="_blank" rel="noopener noreferrer" className="chat-source-link">
                                {src.title || src.uri}
                              </a>
                            ) : (
                              <span className="chat-source-link">{src.title || "Source"}</span>
                            )}
                            {src.text && <span className="chat-source-snippet">{src.text}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="chat-placeholder">No messages yet.</div>
          )}
          {isLoading && <div className="chat-message">Sending...</div>}
        </div>

        <form onSubmit={handleSend} className="howl-chat-form">
          <input
            type="text"
            placeholder="Type a message..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
          />
          <button type="submit" disabled={isLoading}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
};

export default HowlChat;
