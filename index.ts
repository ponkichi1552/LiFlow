import './src/platform/diagnostics/startup-clock';

// Android may start JS for a task with no Activity or mounted Router layout.
import './src/features/google-sync/background-task';

// Expo Router must register the app after background task definitions exist.
import 'expo-router/entry';
