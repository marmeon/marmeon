import { Container } from '../../container.ts';
import { Clock, FixedClock } from './services.ts';
import { WelcomeController } from './WelcomeController.ts';

const controller = new Container().bind(Clock, FixedClock).make(WelcomeController);
console.log(controller.handle());

try {
  controller.fail();
} catch (error) {
  console.log((error as Error).stack!.split('\n')[1]!.trim());
}
