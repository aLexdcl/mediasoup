import { Duplex } from 'stream';
// @ts-ignore
import * as netstring from 'netstring';
import Logger from './Logger';
import EnhancedEventEmitter from './EnhancedEventEmitter';
import { InvalidStateError } from './errors';

interface Sent
{
	id: number;
	method: string;
	resolve: (data?: any) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timer;
	close: () => void;
}

// netstring length for a 4194304 bytes payload.
const NS_MESSAGE_MAX_LEN = 4194313;
const NS_PAYLOAD_MAX_LEN = 4194304;

export default class Channel extends EnhancedEventEmitter
{
	// Logger for logs from the worker process.
	private readonly _workerLogger: Logger;

	// Closed flag.
	private _closed = false;

	// Unix Socket instance for sending messages to the worker process.
	private readonly _producerSocket: Duplex;

	// Unix Socket instance for receiving messages to the worker process.
	private readonly _consumerSocket: Duplex;

	// Next id for messages sent to the worker process.
	private _nextId = 0;

	// Map of pending sent requests.
	private readonly _sents: Map<number, Sent> = new Map();

	// Buffer for reading messages from the worker.
	private _recvBuffer?: Buffer;

	/**
	 * @private
	 */
	constructor(
		{
			producerSocket,
			consumerSocket,
			pid
		}:
		{
			producerSocket: any;
			consumerSocket: any;
			pid: number;
		})
	{
		super(new Logger(`Channel[pid:${pid}]`));

		this._logger.debug('constructor()');

		this._workerLogger = new Logger(`worker[pid:${pid}]`);
		this._producerSocket = producerSocket as Duplex;
		this._consumerSocket = consumerSocket as Duplex;

		// Read Channel responses/notifications from the worker.
		this._consumerSocket.on('data', (buffer) =>
		{
			if (!this._recvBuffer)
			{
				this._recvBuffer = buffer;
			}
			else
			{
				this._recvBuffer = Buffer.concat(
					[ this._recvBuffer, buffer ],
					this._recvBuffer.length + buffer.length);
			}

			if (this._recvBuffer.length > NS_PAYLOAD_MAX_LEN)
			{
				this._logger.error('receiving buffer is full, discarding all data into it');

				// Reset the buffer and exit.
				this._recvBuffer = null;

				return;
			}

			while (true) // eslint-disable-line no-constant-condition
			{
				let nsPayload;

				try
				{
					nsPayload = netstring.nsPayload(this._recvBuffer);
				}
				catch (error)
				{
					this._logger.error(
						'invalid netstring data received from the worker process: %s', String(error));

					// Reset the buffer and exit.
					this._recvBuffer = undefined;

					return;
				}

				// Incomplete netstring message.
				if (nsPayload === -1)
					return;

				try
				{
					// We can receive JSON messages (Channel messages) or log strings.
					switch (nsPayload[0])
					{
						// 123 = '{' (a Channel JSON messsage).
						case 123:
							this._processMessage(JSON.parse(nsPayload));
							break;

						// 68 = 'D' (a debug log).
						case 68:
							this._workerLogger.debug(nsPayload.toString('utf8', 1));
							break;

						// 87 = 'W' (a warn log).
						case 87:
							this._workerLogger.warn(nsPayload.toString('utf8', 1));
							break;

						// 69 = 'E' (an error log).
						case 69:
							this._workerLogger.error(nsPayload.toString('utf8', 1));
							break;

						// 88 = 'X' (a dump log).
						case 88:
							// eslint-disable-next-line no-console
							console.log(nsPayload.toString('utf8', 1));
							break;

						default:
							// eslint-disable-next-line no-console
							console.warn(
								`worker[pid:${pid}] unexpected data: %s`, nsPayload.toString('utf8', 1));
					}
				}
				catch (error)
				{
					this._logger.error(
						'received invalid message from the worker process: %s', String(error));
				}

				// Remove the read payload from the buffer.
				this._recvBuffer =
					this._recvBuffer.slice(netstring.nsLength(this._recvBuffer));

				if (!this._recvBuffer.length)
				{
					this._recvBuffer = undefined;

					return;
				}
			}
		});

		this._consumerSocket.on('end', () => this._logger.debug('Consumer Channel ended by the worker process'));
		this._consumerSocket.on('error', (error) => this._logger.error('Consumer Channel error: %s', String(error)));

		this._producerSocket.on('end', () => this._logger.debug('Producer Channel ended by the worker process'));
		this._producerSocket.on('error', (error) => this._logger.error('Producer Channel error: %s', String(error)));
	}

	/**
	 * @private
	 */
	close(): void
	{
		if (this._closed)
			return;

		this._logger.debug('close()');

		this._closed = true;

		// Close every pending sent.
		for (const sent of this._sents.values())
		{
			sent.close();
		}

		// Remove event listeners but leave a fake 'error' hander to avoid
		// propagation.
		this._consumerSocket.removeAllListeners('end');
		this._consumerSocket.removeAllListeners('error');
		this._consumerSocket.on('error', () => {});

		this._producerSocket.removeAllListeners('end');
		this._producerSocket.removeAllListeners('error');
		this._producerSocket.on('error', () => {});

		// Destroy the socket after a while to allow pending incoming messages.
		setTimeout(() =>
		{
			try { this._producerSocket.destroy(); }
			catch (error) {}
			try { this._consumerSocket.destroy(); }
			catch (error) {}
		}, 200);
	}

	/**
	 * @private
	 */
	async request(method: string, internal?: object, data?: any): Promise<any>
	{
		this._nextId < 4294967295 ? ++this._nextId : (this._nextId = 1);

		const id = this._nextId;

		this._logger.debug('request() [method:%s, id:%s]', method, id);

		if (this._closed)
			throw new InvalidStateError('Channel closed');

		const request = { id, method, internal, data };
		const ns = netstring.nsWrite(JSON.stringify(request));

		if (Buffer.byteLength(ns) > NS_MESSAGE_MAX_LEN)
			throw new Error('Channel request too big');

		// This may throw if closed or remote side ended.
		this._producerSocket.write(ns);

		return new Promise((pResolve, pReject) =>
		{
			const timeout = 1000 * (15 + (0.1 * this._sents.size));
			const sent: Sent =
			{
				id      : id,
				method  : method,
				resolve : (data2) =>
				{
					if (!this._sents.delete(id))
						return;

					clearTimeout(sent.timer);
					pResolve(data2);
				},
				reject : (error) =>
				{
					if (!this._sents.delete(id))
						return;

					clearTimeout(sent.timer);
					pReject(error);
				},
				timer : setTimeout(() =>
				{
					if (!this._sents.delete(id))
						return;

					pReject(new Error('Channel request timeout'));
				}, timeout),
				close : () =>
				{
					clearTimeout(sent.timer);
					pReject(new InvalidStateError('Channel closed'));
				}
			};

			// Add sent stuff to the map.
			this._sents.set(id, sent);
		});
	}

	private _processMessage(msg: any): void
	{
		// If a response retrieve its associated request.
		if (msg.id)
		{
			const sent = this._sents.get(msg.id);

			if (!sent)
			{
				this._logger.error(
					'received response does not match any sent request [id:%s]', msg.id);

				return;
			}

			if (msg.accepted)
			{
				this._logger.debug(
					'request succeeded [method:%s, id:%s]', sent.method, sent.id);

				sent.resolve(msg.data);
			}
			else if (msg.error)
			{
				this._logger.warn(
					'request failed [method:%s, id:%s]: %s',
					sent.method, sent.id, msg.reason);

				switch (msg.error)
				{
					case 'TypeError':
						sent.reject(new TypeError(msg.reason));
						break;

					default:
						sent.reject(new Error(msg.reason));
				}
			}
			else
			{
				this._logger.error(
					'received response is not accepted nor rejected [method:%s, id:%s]',
					sent.method, sent.id);
			}
		}
		// If a notification emit it to the corresponding entity.
		else if (msg.targetId && msg.event)
		{
			this.emit(msg.targetId, msg.event, msg.data);
		}
		// Otherwise unexpected message.
		else
		{
			this._logger.error(
				'received message is not a response nor a notification');
		}
	}
}
