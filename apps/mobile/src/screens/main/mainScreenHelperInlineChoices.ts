import type { ChatMessage as ChatTranscriptMessage } from '../../api/types';
import { getMessageText } from '../../api/messages';
import {
  INLINE_CHOICE_CUE_PATTERNS,
  INLINE_OPTION_LINE_PATTERN,
} from './mainScreenHelperTypes';

export function normalizeQuestionAnswers(value: string): string[] {
  return value
    .split('\n')
    .flatMap((line) => line.split(','))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function findInlineChoiceSet(messages: ChatTranscriptMessage[]): {
  messageId: string;
  options: Array<{ label: string; description: string }>;
} | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') {
      continue;
    }

    const messageText = getMessageText(message);
    if (messageText.length > 1200) {
      continue;
    }

    const parsed = parseInlineOptionsFromQuestionText(messageText);
    if (!parsed.options || parsed.options.length < 2 || parsed.options.length > 5) {
      continue;
    }

    const cueSource = parsed.question.trim();
    const hasCue =
      cueSource.includes('?') ||
      INLINE_CHOICE_CUE_PATTERNS.some((pattern) => pattern.test(cueSource));
    if (!hasCue) {
      continue;
    }

    return {
      messageId: message.id,
      options: parsed.options,
    };
  }

  return null;
}

export function stripOptionText(value: string): string {
  return value
    .trim()
    .replace(/^[`*_~]+/g, '')
    .replace(/[`*_~]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitOptionLine(value: string): { label: string; description: string } {
  const normalized = value.replace(/^[-*+\u2022]\s+/, '').trim();
  if (!normalized) {
    return {
      label: '',
      description: '',
    };
  }

  const separators = [' \u2014 ', ' - ', ': '];
  for (const separator of separators) {
    const separatorIndex = normalized.indexOf(separator);
    if (separatorIndex <= 0 || separatorIndex >= normalized.length - separator.length) {
      continue;
    }

    const label = stripOptionText(normalized.slice(0, separatorIndex));
    const description = stripOptionText(
      normalized.slice(separatorIndex + separator.length)
    );
    if (!label) {
      continue;
    }

    return {
      label,
      description,
    };
  }

  return {
    label: stripOptionText(normalized),
    description: '',
  };
}

export function isLikelyOptionContinuationLine(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  return (
    /^[-*+\u2022]\s+/.test(trimmed) ||
    /^(impact|trade[- ]?off|reason|because|benefit|cost|why)\b/i.test(trimmed)
  );
}

export function parseInlineOptionsFromQuestionText(value: string): {
  question: string;
  options: Array<{ label: string; description: string }> | null;
} {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      question: value,
      options: null,
    };
  }

  const promptLines: string[] = [];
  const options: Array<{ label: string; description: string }> = [];
  let hasMatchedOptionLine = false;

  for (const line of lines) {
    const optionMatch = line.match(INLINE_OPTION_LINE_PATTERN);
    if (optionMatch) {
      const parsed = splitOptionLine(optionMatch[1] ?? '');
      if (parsed.label) {
        options.push(parsed);
        hasMatchedOptionLine = true;
        continue;
      }
    }

    if (hasMatchedOptionLine && options.length > 0 && isLikelyOptionContinuationLine(line)) {
      const continuation = stripOptionText(line.replace(/^[-*+\u2022]\s+/, ''));
      if (continuation) {
        const lastOption = options[options.length - 1];
        lastOption.description = lastOption.description
          ? `${lastOption.description} ${continuation}`
          : continuation;
      }
      continue;
    }

    promptLines.push(line);
  }

  if (options.length < 2) {
    return {
      question: value,
      options: null,
    };
  }

  const question = promptLines.length > 0 ? promptLines.join('\n') : 'Select one option.';

  return {
    question,
    options,
  };
}
