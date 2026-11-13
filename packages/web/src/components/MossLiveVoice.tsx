/**
 * Moss-Live realtime voice mode — floating popover.
 *
 * A compact floating panel (bottom-right) that allows voice
 * conversation while still using the main chat UI.
 */

import { memo, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff, Loader2, Wifi, WifiOff, Minimize2, Maximize2, X } from "lucide-react";
import { useMossLive } from "../hooks/useMossLive";

function MossLiveVoice({ onClose }: { onClose: () => void }) {
  const {
    state,
    micEnabled,
    inputText,
    outputText,
    error,
    connect,
    disconnect,
    toggleMic,
  } = useMossLive();

  const [expanded, setExpanded] = useState(false);
  const isConnected = state === "ready" || state === "configuring" || state === "connected";
  const isReady = state === "ready";

  // Compact mode: just a small floating bar
  if (!expanded && !isConnected && state === "idle") {
    return (
      <div className="fixed bottom-20 right-6 z-50 flex items-center gap-2 rounded-full bg-gray-900/95 px-4 py-2.5 shadow-2xl border border-gray-700/50 backdrop-blur-sm">
        <button
          onClick={() => { connect(); setExpanded(true); }}
          className="flex items-center gap-2 text-sm text-white hover:text-green-400 transition-colors"
        >
          <Phone className="h-4 w-4" />
          开始通话
        </button>
        <button
          onClick={onClose}
          className="p-0.5 text-gray-500 hover:text-gray-300 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`fixed z-50 shadow-2xl border border-gray-700/50 backdrop-blur-sm transition-all duration-200 ${
        expanded
          ? "bottom-20 right-6 w-80 rounded-2xl bg-gray-900/95"
          : "bottom-20 right-6 rounded-full bg-gray-900/95"
      }`}
    >
      {/* Expanded panel */}
      {expanded ? (
        <div className="p-4 space-y-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-gray-400">
              {isConnected ? (
                <Wifi className="h-3 w-3 text-green-400" />
              ) : (
                <WifiOff className="h-3 w-3 text-gray-500" />
              )}
              <span>
                {state === "idle" && "未连接"}
                {state === "connecting" && "连接中..."}
                {state === "connected" && "已连接"}
                {state === "configuring" && "配置中..."}
                {state === "ready" && "就绪"}
                {state === "error" && "连接错误"}
                {state === "disconnected" && "已断开"}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setExpanded(false)}
                className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
                title="最小化"
              >
                <Minimize2 className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => { disconnect(); onClose(); }}
                className="p-1 text-gray-500 hover:text-red-400 transition-colors"
                title="关闭"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="text-xs text-red-400 bg-red-900/30 px-3 py-1.5 rounded-lg truncate">
              {error}
            </div>
          )}

          {/* Transcript area */}
          <div className="min-h-[60px] max-h-[120px] overflow-y-auto">
            {outputText ? (
              <p className="text-sm text-white leading-relaxed">
                {outputText}
              </p>
            ) : isReady ? (
              <p className="text-xs text-gray-500">
                {micEnabled ? "正在听..." : "点击麦克风开始说话"}
              </p>
            ) : null}
            {inputText && (
              <p className="text-xs text-blue-300/70 mt-1 italic">
                {inputText}
              </p>
            )}
          </div>

          {/* Controls */}
          <div className="flex items-center justify-center gap-3">
            {state === "idle" || state === "disconnected" || state === "error" ? (
              <button
                onClick={connect}
                className="flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-500 rounded-full text-sm text-white transition-colors"
              >
                <Phone className="h-4 w-4" />
                连接
              </button>
            ) : (
              <>
                <button
                  onClick={toggleMic}
                  disabled={!isReady}
                  className={`p-3 rounded-full transition-all ${
                    micEnabled
                      ? "bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-600/20"
                      : "bg-gray-700 hover:bg-gray-600"
                  } ${!isReady ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  {micEnabled ? (
                    <Mic className="h-5 w-5 text-white" />
                  ) : (
                    <MicOff className="h-5 w-5 text-gray-400" />
                  )}
                </button>
                <button
                  onClick={disconnect}
                  className="p-2.5 rounded-full bg-red-600/80 hover:bg-red-500 transition-colors"
                  title="挂断"
                >
                  <PhoneOff className="h-4 w-4 text-white" />
                </button>
                {(state === "connecting" || state === "configuring") && (
                  <Loader2 className="h-4 w-4 text-gray-400 animate-spin" />
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        /* Compact connected bar */
        <div className="flex items-center gap-2 px-3 py-2">
          {/* Mic indicator / toggle */}
          <button
            onClick={toggleMic}
            disabled={!isReady}
            className={`p-2 rounded-full transition-all ${
              micEnabled
                ? "bg-blue-600 shadow-md shadow-blue-600/30"
                : "bg-gray-700"
            } ${!isReady ? "opacity-50" : ""}`}
          >
            {micEnabled ? (
              <Mic className="h-4 w-4 text-white" />
            ) : (
              <MicOff className="h-4 w-4 text-gray-400" />
            )}
          </button>

          {/* Brief transcript */}
          <div className="flex-1 min-w-0 max-w-[140px]">
            {outputText ? (
              <p className="text-xs text-white truncate">{outputText}</p>
            ) : (
              <p className="text-xs text-gray-500">
                {micEnabled ? "正在听..." : "语音通话中"}
              </p>
            )}
          </div>

          {/* Expand */}
          <button
            onClick={() => setExpanded(true)}
            className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>

          {/* Hang up */}
          <button
            onClick={disconnect}
            className="p-1.5 rounded-full bg-red-600/80 hover:bg-red-500 transition-colors"
          >
            <PhoneOff className="h-3.5 w-3.5 text-white" />
          </button>
        </div>
      )}
    </div>
  );
}

export default memo(MossLiveVoice);
