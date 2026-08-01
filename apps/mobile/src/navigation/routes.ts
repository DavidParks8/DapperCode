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
  gitCheckout(profileId: string, chatId: string): Href {
    return {
      pathname: '/profiles/[profileId]/chats/[chatId]/git-checkout',
      params: { profileId, chatId },
    };
  },
  browser(profileId: string): Href {
    return { pathname: '/profiles/[profileId]/browser', params: { profileId } };
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
  connection(profileId: string, chatId: string, mode: ConnectionMode): Href {
    return {
      pathname: '/profiles/[profileId]/chats/[chatId]/connection',
      params: { profileId, chatId, mode },
    };
  },
};
