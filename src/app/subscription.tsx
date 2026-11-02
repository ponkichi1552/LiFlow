import { router } from 'expo-router';
import { SubscriptionScreen } from '../features/subscription/subscription-screen';
export default function SubscriptionRoute() { return <SubscriptionScreen onBack={() => router.back()} />; }
