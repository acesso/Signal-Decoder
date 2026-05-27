'use client';

import { useState } from 'react';
import RTTYDecoder from "@/components/SSTVDecoder";
import SSTVImageDecoder from "@/components/SSTVImageDecoder";

type DecoderMode = 'rtty' | 'sstv';

const MODE_META: Record<DecoderMode, { label: string; badge: string; description: string }> = {
  rtty: {
    label: 'RTTY',
    badge: 'RTTY Mode',
    description: 'Real-time Radioteletype signal decoder from microphone',
  },
  sstv: {
    label: 'SSTV',
    badge: 'SSTV Mode',
    description: 'Slow Scan Television image decoder — Robot, Scottie, PD modes',
  },
};

export default function Home() {
  const [mode, setMode] = useState<DecoderMode>('rtty');
  const meta = MODE_META[mode];

  return (
    <main className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-4 sm:pt-6 lg:pt-8 pb-4 shrink-0">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold mb-1 text-[#c9d1d9]">
              Radio Signal Decoder
            </h1>
            <p className="text-sm sm:text-base text-[#8b949e]">
              {meta.description}
            </p>
          </div>

          {/* Mode toggle */}
          <div className="flex items-center gap-1 shrink-0 bg-[#0d1117] border border-[#30363d] rounded-lg p-1">
            {(['rtty', 'sstv'] as DecoderMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-colors ${
                  mode === m
                    ? 'bg-[#238636] text-white'
                    : 'text-[#8b949e] hover:text-[#c9d1d9]'
                }`}
              >
                {MODE_META[m].label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mt-3">
          <a
            href="https://github.com/smolgroot/sstv-decoder"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-[#238636]/10 text-[#2ea043] border border-[#238636]/30 hover:bg-[#238636]/20 hover:border-[#238636]/50 transition-colors"
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            Source Code
          </a>
          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-[#238636]/10 text-[#2ea043] border border-[#238636]/30">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
              <path d="M2.75 3.75a.75.75 0 000 1.5h10.5a.75.75 0 000-1.5H2.75zM2 7.75A.75.75 0 012.75 7h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 7.75zm0 4a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z"/>
            </svg>
            {meta.badge}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 lg:px-8 pb-8">
        {mode === 'rtty' ? <RTTYDecoder /> : <SSTVImageDecoder />}
      </div>
    </main>
  );
}
