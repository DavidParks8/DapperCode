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
  contextTokens: number;
  kvBytesPerToken: number;
  workingBytes: number;
  minimumDeviceBytes: number;
  recommended: boolean;
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
