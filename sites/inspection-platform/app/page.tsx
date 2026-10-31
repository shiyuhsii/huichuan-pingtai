import { requireChatGPTUser } from './chatgpt-auth';
import InspectionApp from './inspection-app';
export const dynamic='force-dynamic';
export default async function Page(){await requireChatGPTUser('/');return <InspectionApp/>;}
