export interface LocalModelDefinition {
  id: string;
  name: string;
  family: string;
  parameters: string;
  quantization: string;
  sourceUrl: string;
  downloadUrl: string;
  sha256: string;
  bytes: number;
  license: string;
  /** Smallest context the agent loop is usable with; memory admission is measured at this size. */
  contextTokens: number;
  /** Native trained context limit; fresh headroom selects the loaded size up to this ceiling. */
  maxContextTokens: number;
  kvBytesPerToken: number;
  workingBytes: number;
  /** Prompt-state checkpoint budget for hybrid/SWA models; 0 for pure-attention models. */
  stateCacheBytes: number;
  minimumDeviceBytes: number;
  recommended: boolean;
  /** Enables the template's reasoning for uncapped rounds, for families that degrade without it. */
  thinking?: boolean;
  runtimeIssue?: string;
}

export interface LocalModelFamily {
  id: string;
  name: string;
  publisher: string;
  description: string;
  quantizationNote?: string;
  badge?: string;
  icon: 'leaf-outline' | 'sparkles-outline' | 'diamond-outline' | 'archive-outline';
  featured: boolean;
}

export interface DeviceMemory {
  physicalBytes: number;
  availableBytes: number;
  isSimulator: boolean;
}

export interface LocalModelFile {
  id: string;
  uri: string;
  sha256: string;
  bytes: number;
}

export interface LocalModelPaths {
  partialUri: string;
  resumeUri: string;
  verificationBytes: number | null;
  availableBytes: number;
}
