import { ref } from 'vue';

export const pendingMailOpen = ref<{ accountId: string; threadId: string } | null>(null);
