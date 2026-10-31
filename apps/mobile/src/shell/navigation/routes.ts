import type { Href } from 'expo-router';

export type ConnectionMode = 'add' | 'edit' | 'reconnect';

export const routes = {
  root: '/' as const,
  onboarding: '/onboarding' as const,
  chat(profileId: string, chatId: string): Href {
    return {
      pathname: '/profiles/[profileId]/chats/[chatId]',
      params: { profileId, chatId },
    };
  },
  newChat(profileId: string): Href {
    return routes.chat(profileId, 'new');
  },
  git(profileId: string, chatId: string): Href {
    return {
      pathname: '/profiles/[profileId]/chats/[chatId]/git',
      params: { profileId, chatId },
    };
  },
  agent(profileId: string, chatId: string, threadId: string): Href {
    return {
      pathname: '/profiles/[profileId]/chats/[chatId]/agents/[threadId]',
      params: { profileId, chatId, threadId },
    };
  },
  workspacePicker(profileId: string, chatId: string): Href {
    return {
      pathname: '/profiles/[profileId]/chats/[chatId]/workspace-picker',
      params: { profileId, chatId },
    };
  },
  /** Files browser for a workspace path presented by the profile's host. */
  files(profileId: string, chatId: string, cwd: string): Href {
    return {
      pathname: '/profiles/[profileId]/chats/[chatId]/files',
      params: { profileId, chatId, cwd },
    };
  },
  gitCheckout(profileId: string, chatId: string): Href {
    return {
      pathname: '/profiles/[profileId]/chats/[chatId]/git-checkout',
      params: { profileId, chatId },
    };
  },
  browser(profileId: string, source?: { chatId: string; threadId?: string }): Href {
    return {
      pathname: '/profiles/[profileId]/browser',
      params: { profileId, returnChatId: source?.chatId, returnThreadId: source?.threadId },
    };
  },
  settings(profileId: string): Href {
    return { pathname: '/profiles/[profileId]/settings', params: { profileId } };
  },
  privacy(profileId: string): Href {
    return { pathname: '/profiles/[profileId]/settings/privacy', params: { profileId } };
  },
  terms(profileId: string): Href {
    return { pathname: '/profiles/[profileId]/settings/terms', params: { profileId } };
  },
  /** On this iPhone: model families, downloads, storage, and the loaded model. */
  settingsModels(profileId: string): Href {
    return { pathname: '/profiles/[profileId]/settings/models', params: { profileId } };
  },
  settingsModelFamily(profileId: string, familyId: string): Href {
    return {
      pathname: '/profiles/[profileId]/settings/models/[familyId]',
      params: { profileId, familyId },
    };
  },
  /** On this iPhone: GitHub sign-in and the Git commit author. */
  settingsGitHub(profileId: string): Href {
    return { pathname: '/profiles/[profileId]/settings/github', params: { profileId } };
  },
  connection(profileId: string, chatId: string, mode: ConnectionMode): Href {
    return {
      pathname: '/profiles/[profileId]/chats/[chatId]/connection',
      params: { profileId, chatId, mode },
    };
  },
  /**
   * Settings-owned connection modal for adding/editing a bridge profile. Unlike `connection`,
   * this is not nested under a chat, so dismissing it (back/cancel) always lands back on
   * Settings rather than whatever chat happened to be selected when it was opened.
   */
  settingsConnection(profileId: string, mode: Extract<ConnectionMode, 'add' | 'edit'>): Href {
    return {
      pathname: '/profiles/[profileId]/settings/connection',
      params: { profileId, mode },
    };
  },
};
