'use client';

import { useState } from 'react';
import RTTYDecoder from "@/components/RTTYDecoder";
import SSTVDecoder from "@/components/SSTVDecoder";
import CWDecoder from "@/components/CWDecoder";

type DecoderMode = 'rtty' | 'sstv' | 'cw';

const MODE_META: Record<DecoderMode, { label: string; description: string }> = {
  rtty: {
    label: 'RTTY',
    description: 'Real-time Radioteletype signal decoder from microphone',
  },
  sstv: {
    label: 'SSTV',
    description: 'Slow Scan Television image decoder — Robot, Scottie, PD modes',
  },
  cw: {
    label: 'CW',
    description: 'Continuous Wave (Morse code) decoder — adaptive speed, real-time text output',
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
            {(['rtty', 'sstv', 'cw'] as DecoderMode[]).map((m) => (
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

      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 lg:px-8 pb-8">
        {mode === 'rtty' ? <RTTYDecoder /> : mode === 'sstv' ? <SSTVDecoder /> : <CWDecoder />}
      </div>
    </main>
  );
}
