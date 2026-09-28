export type VkAuthSettings = { enabled: boolean; clientId: string };
export type VkAuthStatus = VkAuthSettings & {
  available: boolean;
  callbackUrl: string;
};
