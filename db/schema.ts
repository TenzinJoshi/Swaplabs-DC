import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("sl_users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("active"),
  verified: integer("verified", {mode: "boolean"}).notNull().default(false),
  timeCredits: integer("time_credits").notNull().default(30),
  rewardPoints: integer("reward_points").notNull().default(0),
  profileJson: text("profile_json").notNull(),
  preferencesJson: text("preferences_json").notNull(),
  safetyJson: text("safety_json").notNull(),
  moderationLabel: text("moderation_label").notNull().default("none"),
  adminNotes: text("admin_notes").notNull().default(""),
  messagingRestricted: integer("messaging_restricted", {mode: "boolean"}).notNull().default(false),
  suspendedUntil: text("suspended_until"),
  suspensionReason: text("suspension_reason").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastLoginAt: text("last_login_at"),
  termsAcceptedAt: text("terms_accepted_at")
}, table => ({
  usernameUnique: uniqueIndex("idx_sl_users_username_unique").on(table.username),
  emailUnique: uniqueIndex("idx_sl_users_email_unique").on(table.email),
  statusIndex: index("idx_sl_users_status").on(table.status),
  createdAtIndex: index("idx_sl_users_created_at").on(table.createdAt)
}));

export const sessions = sqliteTable("sl_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull()
}, table => ({
  userIndex: index("idx_sl_sessions_user_id").on(table.userId),
  expiryIndex: index("idx_sl_sessions_expires_at").on(table.expiresAt)
}));

export const userPresence = sqliteTable("sl_user_presence", {
  userId: text("user_id").primaryKey().references(() => users.id, {onDelete: "cascade"}),
  lastSeenAt: text("last_seen_at").notNull(),
  pagePath: text("page_path").notNull().default(""),
  updatedAt: text("updated_at").notNull()
}, table => ({
  lastSeenIndex: index("idx_sl_user_presence_last_seen").on(table.lastSeenAt)
}));

export const userPresenceDays = sqliteTable("sl_user_presence_days", {
  userId: text("user_id").notNull().references(() => users.id, {onDelete: "cascade"}),
  dayKey: text("day_key").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  pagePath: text("page_path").notNull().default(""),
  updatedAt: text("updated_at").notNull()
}, table => ({
  primaryKey: primaryKey({columns: [table.userId, table.dayKey]}),
  lastSeenIndex: index("idx_sl_user_presence_days_last_seen").on(table.lastSeenAt)
}));

export const auditLog = sqliteTable("sl_audit_log", {
  id: text("id").primaryKey(),
  actorId: text("actor_id"),
  targetId: text("target_id"),
  action: text("action").notNull(),
  details: text("details").notNull().default(""),
  createdAt: text("created_at").notNull()
}, table => ({
  createdAtIndex: index("idx_sl_audit_log_created_at").on(table.createdAt),
  targetIndex: index("idx_sl_audit_log_target_id").on(table.targetId)
}));

export const workshops = sqliteTable("sl_workshops", {
  id: text("id").primaryKey(),
  hostId: text("host_id").notNull(),
  eventId: text("event_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  level: text("level").notNull(),
  format: text("format").notNull(),
  location: text("location").notNull(),
  timezone: text("timezone").notNull(),
  startsAt: text("starts_at").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  seatLimit: integer("seat_limit").notNull(),
  outcomesJson: text("outcomes_json").notNull().default("[]"),
  tagsJson: text("tags_json").notNull().default("[]"),
  status: text("status").notNull().default("scheduled"),
  adminNotes: text("admin_notes").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, table => ({
  startsIndex: index("idx_sl_workshops_status_starts").on(table.status, table.startsAt)
}));

export const workshopRegistrations = sqliteTable("sl_workshop_registrations", {
  id: text("id").primaryKey(),
  workshopId: text("workshop_id").notNull(),
  userId: text("user_id").notNull(),
  status: text("status").notNull().default("registered"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, table => ({
  uniqueRegistration: uniqueIndex("idx_sl_workshop_registration_unique").on(table.workshopId, table.userId),
  workshopIndex: index("idx_sl_workshop_registration_workshop_status").on(table.workshopId, table.status)
}));

export const workshopShares = sqliteTable("sl_workshop_shares", {
  shareId: text("share_id").primaryKey(),
  workshopId: text("workshop_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull()
}, table => ({
  workshopUnique: uniqueIndex("idx_sl_workshop_shares_workshop_unique").on(table.workshopId),
  expiryIndex: index("idx_sl_workshop_shares_expiry").on(table.expiresAt)
}));

export const courses = sqliteTable("sl_courses", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  category: text("category").notNull().default("Other"),
  level: text("level").notNull().default("All levels"),
  estimatedHours: real("estimated_hours").notNull().default(1),
  resourceUrl: text("resource_url").notNull().default(""),
  visibility: text("visibility").notNull().default("private"),
  status: text("status").notNull().default("draft"),
  lessonsJson: text("lessons_json").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  publishedAt: text("published_at")
}, table => ({
  publicCreatedIndex: index("idx_sl_courses_public_created").on(table.visibility, table.status, table.publishedAt),
  ownerCreatedIndex: index("idx_sl_courses_owner_created").on(table.ownerId, table.createdAt)
}));

export const conversations = sqliteTable("sl_conversations", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull().default("direct"),
  title: text("title").notNull().default(""),
  createdBy: text("created_by").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, table => ({
  updatedIndex: index("idx_sl_conversations_updated").on(table.updatedAt)
}));

export const conversationMembers = sqliteTable("sl_conversation_members", {
  conversationId: text("conversation_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("member"),
  muted: integer("muted", {mode: "boolean"}).notNull().default(false),
  hidden: integer("hidden", {mode: "boolean"}).notNull().default(false),
  lastReadAt: text("last_read_at"),
  createdAt: text("created_at").notNull()
}, table => ({
  primary: primaryKey({columns: [table.conversationId, table.userId]}),
  userIndex: index("idx_sl_conversation_members_user_hidden").on(table.userId, table.hidden)
}));

export const directConversations = sqliteTable("sl_direct_conversations", {
  pairKey: text("pair_key").primaryKey(),
  conversationId: text("conversation_id").notNull()
}, table => ({
  conversationUnique: uniqueIndex("idx_sl_direct_conversations_id").on(table.conversationId)
}));

export const messages = sqliteTable("sl_messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  senderId: text("sender_id"),
  body: text("body").notNull().default(""),
  metadataJson: text("metadata_json").notNull().default("{}"),
  moderationStatus: text("moderation_status").notNull().default("visible"),
  pinned: integer("pinned", {mode: "boolean"}).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, table => ({
  conversationIndex: index("idx_sl_messages_conversation_created").on(table.conversationId, table.createdAt)
}));

export const creditVouchers = sqliteTable("sl_credit_vouchers", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull(),
  codePrefix: text("code_prefix").notNull(),
  creatorId: text("creator_id").notNull(),
  amount: integer("amount").notNull(),
  status: text("status").notNull().default("active"),
  redeemerId: text("redeemer_id"),
  createdAt: text("created_at").notNull(),
  redeemedAt: text("redeemed_at")
}, table => ({
  codeUnique: uniqueIndex("idx_sl_credit_vouchers_code_hash_unique").on(table.codeHash),
  creatorStatusIndex: index("idx_sl_credit_vouchers_creator_status_created").on(table.creatorId, table.status, table.createdAt),
  statusIndex: index("idx_sl_credit_vouchers_status").on(table.status)
}));

export const communityPosts = sqliteTable("sl_community_posts", {
  id: text("id").primaryKey(),
  authorId: text("author_id").notNull(),
  body: text("body").notNull().default(""),
  visibility: text("visibility").notNull().default("public"),
  mediaKey: text("media_key").notNull().default(""),
  mediaType: text("media_type").notNull().default(""),
  mediaContentType: text("media_content_type").notNull().default(""),
  status: text("status").notNull().default("published"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, table => ({
  createdIndex: index("idx_sl_community_posts_created").on(table.createdAt),
  authorIndex: index("idx_sl_community_posts_author_created").on(table.authorId, table.createdAt),
  statusIndex: index("idx_sl_community_posts_status_created").on(table.status, table.createdAt)
}));

export const communityPostLikes = sqliteTable("sl_community_post_likes", {
  id: text("id").primaryKey(),
  postId: text("post_id").notNull(),
  userId: text("user_id").notNull(),
  createdAt: text("created_at").notNull()
}, table => ({
  uniqueLike: uniqueIndex("idx_sl_community_post_likes_unique").on(table.postId, table.userId),
  postIndex: index("idx_sl_community_post_likes_post").on(table.postId, table.createdAt),
  userIndex: index("idx_sl_community_post_likes_user").on(table.userId, table.createdAt)
}));

export const communityPostComments = sqliteTable("sl_community_post_comments", {
  id: text("id").primaryKey(),
  postId: text("post_id").notNull(),
  authorId: text("author_id").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull().default("visible"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, table => ({
  postIndex: index("idx_sl_community_post_comments_post_created").on(table.postId, table.createdAt),
  authorIndex: index("idx_sl_community_post_comments_author_created").on(table.authorId, table.createdAt),
  statusIndex: index("idx_sl_community_post_comments_status").on(table.status)
}));

export const communityPostShares = sqliteTable("sl_community_post_shares", {
  id: text("id").primaryKey(),
  postId: text("post_id").notNull(),
  userId: text("user_id").notNull(),
  createdAt: text("created_at").notNull()
}, table => ({
  uniqueShare: uniqueIndex("idx_sl_community_post_shares_unique").on(table.postId, table.userId),
  postIndex: index("idx_sl_community_post_shares_post").on(table.postId, table.createdAt),
  userIndex: index("idx_sl_community_post_shares_user").on(table.userId, table.createdAt)
}));

export const communityStories = sqliteTable("sl_community_stories", {
  id: text("id").primaryKey(),
  authorId: text("author_id").notNull(),
  body: text("body").notNull().default(""),
  visibility: text("visibility").notNull().default("public"),
  mediaKey: text("media_key").notNull().default(""),
  mediaType: text("media_type").notNull().default(""),
  mediaContentType: text("media_content_type").notNull().default(""),
  status: text("status").notNull().default("published"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, table => ({
  expiryIndex: index("idx_sl_community_stories_expires").on(table.expiresAt, table.status),
  authorIndex: index("idx_sl_community_stories_author_created").on(table.authorId, table.createdAt),
  statusIndex: index("idx_sl_community_stories_status_created").on(table.status, table.createdAt)
}));

export const communityGroups = sqliteTable("sl_community_groups", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  category: text("category").notNull().default("Community"),
  icon: text("icon").notNull().default("bx-group"),
  accent: text("accent").notNull().default("blue"),
  requiresApproval: integer("requires_approval", {mode: "boolean"}).notNull().default(false),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, table => ({
  conversationUnique: uniqueIndex("idx_sl_community_groups_conversation_unique").on(table.conversationId),
  createdIndex: index("idx_sl_community_groups_created").on(table.createdAt)
}));

export const communityGroupMembers = sqliteTable("sl_community_group_members", {
  groupId: text("group_id").notNull(),
  userId: text("user_id").notNull(),
  status: text("status").notNull().default("active"),
  role: text("role").notNull().default("member"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, table => ({
  primary: primaryKey({columns: [table.groupId, table.userId]}),
  userStatusIndex: index("idx_sl_community_group_members_user_status").on(table.userId, table.status)
}));

export const communityGroupJoinRequests = sqliteTable("sl_community_group_join_requests", {
  id: text("id").primaryKey(),
  groupId: text("group_id").notNull(),
  userId: text("user_id").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, table => ({
  uniqueRequest: uniqueIndex("idx_sl_community_group_join_requests_unique").on(table.groupId, table.userId),
  groupStatusIndex: index("idx_sl_community_group_join_requests_group_status").on(table.groupId, table.status)
}));

export const livestreams = sqliteTable("sl_livestreams", {
  id: text("id").primaryKey(),
  hostId: text("host_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  category: text("category").notNull().default("Community"),
  tagsJson: text("tags_json").notNull().default("[]"),
  scheduledAt: text("scheduled_at"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  status: text("status").notNull().default("scheduled"),
  durationMinutes: integer("duration_minutes").notNull().default(120),
  creditsDonated: integer("credits_donated").notNull().default(0),
  rewardCreditsAwarded: integer("reward_credits_awarded").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, table => ({
  statusScheduleIndex: index("idx_sl_livestreams_status_schedule").on(table.status, table.scheduledAt),
  hostCreatedIndex: index("idx_sl_livestreams_host_created").on(table.hostId, table.createdAt)
}));

export const livestreamMembers = sqliteTable("sl_livestream_members", {
  streamId: text("stream_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("viewer"),
  joinedAt: text("joined_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  leftAt: text("left_at")
}, table => ({
  primary: primaryKey({columns: [table.streamId, table.userId]}),
  activeIndex: index("idx_sl_livestream_members_stream_active").on(table.streamId, table.leftAt, table.lastSeenAt)
}));

export const livestreamChat = sqliteTable("sl_livestream_chat", {
  id: text("id").primaryKey(),
  streamId: text("stream_id").notNull(),
  userId: text("user_id").notNull(),
  body: text("body").notNull(),
  donationCredits: integer("donation_credits").notNull().default(0),
  createdAt: text("created_at").notNull()
}, table => ({
  streamCreatedIndex: index("idx_sl_livestream_chat_stream_created").on(table.streamId, table.createdAt)
}));

export const livestreamSignals = sqliteTable("sl_livestream_signals", {
  id: text("id").primaryKey(),
  streamId: text("stream_id").notNull(),
  fromId: text("from_id").notNull(),
  toId: text("to_id"),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: text("created_at").notNull()
}, table => ({
  streamCreatedIndex: index("idx_sl_livestream_signals_stream_created").on(table.streamId, table.createdAt),
  targetCreatedIndex: index("idx_sl_livestream_signals_target_created").on(table.streamId, table.toId, table.createdAt)
}));

export const blockedWords = sqliteTable("sl_blocked_words", {
  id: text("id").primaryKey(),
  phrase: text("phrase").notNull(),
  normalizedPhrase: text("normalized_phrase").notNull(),
  enabled: integer("enabled", {mode: "boolean"}).notNull().default(true),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, table => ({
  normalizedUnique: uniqueIndex("idx_sl_blocked_words_normalized_unique").on(table.normalizedPhrase),
  enabledIndex: index("idx_sl_blocked_words_enabled").on(table.enabled, table.createdAt)
}));

export const moderationItems = sqliteTable("sl_moderation_items", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  contentType: text("content_type").notNull(),
  sourcePath: text("source_path").notNull(),
  sourceMethod: text("source_method").notNull(),
  payloadJson: text("payload_json").notNull(),
  contentJson: text("content_json").notNull(),
  fileContextJson: text("file_context_json").notNull().default("[]"),
  submitterJson: text("submitter_json").notNull().default("{}"),
  triggeredRuleId: text("triggered_rule_id"),
  triggeredRule: text("triggered_rule").notNull(),
  triggeredRulesJson: text("triggered_rules_json").notNull().default("[]"),
  status: text("status", {enum: ["pending", "approved", "deleted"]}).notNull().default("pending"),
  submittedAt: text("submitted_at").notNull(),
  reviewedBy: text("reviewed_by"),
  reviewedAt: text("reviewed_at"),
  reviewLockAt: text("review_lock_at"),
  replaySecretHash: text("replay_secret_hash").notNull().default("")
}, table => ({
  statusSubmittedIndex: index("idx_sl_moderation_items_status_submitted").on(table.status, table.submittedAt),
  userSubmittedIndex: index("idx_sl_moderation_items_user_submitted").on(table.userId, table.submittedAt)
}));

export const moderationFiles = sqliteTable("sl_moderation_files", {
  itemId: text("item_id").notNull(),
  fileIndex: integer("file_index").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  fileSize: integer("file_size").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  chunkData: blob("chunk_data", {mode: "buffer"}).notNull()
}, table => ({
  primary: primaryKey({columns: [table.itemId, table.fileIndex, table.chunkIndex]}),
  itemIndex: index("idx_sl_moderation_files_item").on(table.itemId, table.fileIndex, table.chunkIndex)
}));

export const moderationAudit = sqliteTable("sl_moderation_audit", {
  id: text("id").primaryKey(),
  contentId: text("content_id").notNull(),
  userId: text("user_id"),
  triggeredRule: text("triggered_rule").notNull(),
  previousStatus: text("previous_status").notNull(),
  newStatus: text("new_status", {enum: ["pending", "approved", "deleted"]}).notNull(),
  adminId: text("admin_id"),
  action: text("action").notNull(),
  createdAt: text("created_at").notNull()
}, table => ({
  contentCreatedIndex: index("idx_sl_moderation_audit_content_created").on(table.contentId, table.createdAt),
  createdIndex: index("idx_sl_moderation_audit_created").on(table.createdAt)
}));
