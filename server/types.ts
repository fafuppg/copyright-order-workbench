export type RecordKind =
  | "customer"
  | "task"
  | "template"
  | "templatefile"
  | "delivery"
  | "intake"
  | "attachment"
  | "settings"
  | "user"
  | "maildraft"
  | "chatsession"
  | "chatmessage"
  | "chatproposal"
  | "mailmessage"
  | "mailboxstate";
export interface Doc {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  [key: string]: any;
}
export interface Task extends Doc {
  customerId: string;
  customerName: string;
  memberName: string;
  email: string;
  wechat: string;
  kind: "new" | "correction";
  softwareName: string;
  intakeName: string;
  originalName: string;
  notes: string;
  purchasedAt: string;
  amount: string;
  orderId: string;
  projectId: string;
  parentId: string | null;
  needsSubmission: boolean;
  completed: boolean;
  completedAt: string | null;
  completionMethod: string;
  imageIds: string[];
  intakeId: string | null;
  archived: boolean;
}
export interface Template extends Doc {
  name: string;
  kind: string;
  subject: string;
  html: string;
  isDefault: boolean;
}
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
