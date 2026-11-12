/**
 * Moss-Live realtime voice mode overlay.
 *
 * Full-screen overlay that shows:
 * - Connection state + mic toggle
 * - Live input transcript (what user is saying)
 * - Live output transcript (what Moss-Live is saying)
 * - Delegation status (background tasks)
 */

import { memo } from "react";
import { Mic, MicOff, Phone, PhoneOff, Loader2, Wifi, WifiOff } from "lucide-react";
import { useMossLive } from "../hooks/useMossLive";

function MossLiveVoice({ onClose }: { onClose: () => void }) {
  const {
    state,
    micEnabled,
    inputText,
    outputText,
    delegation,
    error,
    connect,
    disconnect,
    toggleMic,
  } = useMossLive();

  const isConnected = state === "ready" || state === "configuring" || state === "connected";
  const isReady = state === "ready";

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/95 text-white">
      {/* Header */}
      <div className="absolute top-6 left-6 flex items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          {isConnected ? (
            <Wifi className="h-4 w-4 text-green-400" />
          ) : (
            <WifiOff className="h-4 w-4 text-gray-500" />
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
      </div>

      {/* Close button */}
      <button
        onClick={() => { disconnect(); onClose(); }}
        className="absolute top-6 right-6 text-gray-400 hover:text-white text-sm"
      >
        退出语音
      </button>

      {/* Main content */}
      <div className="flex flex-col items-center gap-8 max-w-2xl w-full px-6">
        {/* Error */}
        {error && (
          <div className="text-red-400 text-sm bg-red-900/30 px-4 py-2 rounded-lg">
            {error}
          </div>
        )}

        {/* Output transcript (what Moss-Live is saying) */}
        <div className="min-h-[120px] flex items-center justify-center">
          {outputText ? (
            <p className="text-3xl font-light text-center leading-relaxed animate-fade-in">
              {outputText}
            </p>
          ) : isReady ? (
            <p className="text-xl text-gray-500">等待对话...</p>
          ) : null}
        </div>

        {/* Input transcript (what user is saying) */}
        {inputText && (
          <div className="min-h-[60px] flex items-center justify-center">
            <p className="text-lg text-blue-300/80 text-center italic">
              {inputText}
            </p>
          </div>
        )}

        {/* Delegation status */}
        {delegation && (
          <div className="text-sm text-amber-400/70 bg-amber-900/20 px-4 py-2 rounded-lg">
            <span className="font-medium">后台任务:</span> {delegation.objective?.slice(0, 80)}
            {delegation.status === "created" && " (排队中)"}
            {delegation.status === "in_progress" && " (执行中...)"}
            {delegation.status === "completed" && " ✅"}
            {delegation.status === "failed" && " ❌"}
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center gap-6 mt-8">
          {state === "idle" || state === "disconnected" || state === "error" ? (
            <button
              onClick={connect}
              className="flex items-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-500 rounded-full text-lg transition-colors"
            >
              <Phone className="h-5 w-5" />
              开始通话
            </button>
          ) : (
            <>
              {/* Mic toggle */}
              <button
                onClick={toggleMic}
                disabled={!isReady}
                className={`
                  p-5 rounded-full transition-all
                  ${micEnabled
                    ? "bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-600/30"
                    : "bg-gray-700 hover:bg-gray-600"
                  }
                  ${!isReady ? "opacity-50 cursor-not-allowed" : ""}
                `}
              >
                {micEnabled ? (
                  <Mic className="h-8 w-8" />
                ) : (
                  <MicOff className="h-8 w-8 text-gray-400" />
                )}
              </button>

              {/* Hang up */}
              <button
                onClick={disconnect}
                className="p-4 rounded-full bg-red-600 hover:bg-red-500 transition-colors"
              >
                <PhoneOff className="h-6 w-6" />
              </button>

              {/* Loading */}
              {(state === "connecting" || state === "configuring") && (
                <Loader2 className="h-6 w-6 text-gray-400 animate-spin" />
              )}
            </>
          )}
        </div>

        {/* Hint */}
        {isReady && !micEnabled && (
          <p className="text-sm text-gray-500 mt-4">
            点击麦克风开始说话
          </p>
        )}
        {isReady && micEnabled && (
          <p className="text-sm text-gray-500 mt-4">
            正在听... 直接说话即可
          </p>
        )}
      </div>
    </div>
  );
}

export default memo(MossLiveVoice);
