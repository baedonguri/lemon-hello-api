/**
 * API: `/hello`
 * - public service api
 *
 *
 * @author  Tyler <tyler@lemoncloud.io>
 * @date    2020-06-10 refactor with api
 *
 * @copyright (C) 2019 LemonCloud Co Ltd. - All Rights Reserved.
 */
import $core, {
    $U,
    _log,
    _inf,
    _err,
    loadJsonSync,
    AWSKMSService,
    AWSSNSService,
    AWSS3Service,
    doReportError,
} from 'lemon-core';
const NS = $U.NS('HELO', 'yellow'); // NAMESPACE TO BE PRINTED.

//! import core services.
import { NextHandler, GeneralWEBController } from 'lemon-core';
import $service, { HelloService, HelloProxyService, ParamForSlack } from '../service/hello-service';

/** ********************************************************************************************************************
 *  MAIN IMPLEMENTATION.
 ** ********************************************************************************************************************/
/**
 * class: `HelloAPIController`
 * - handle hello api-service.
 */
class HelloAPIController extends GeneralWEBController {
    private NODES: { name: string }[];
    protected service: HelloService;
    protected $kms: AWSKMSService;
    protected $sns: AWSSNSService;
    protected $s3s: AWSS3Service;

    /**
     * default constructor.
     */
    public constructor(service?: HelloService, $kms?: AWSKMSService, $sns?: AWSSNSService, $s3s?: AWSS3Service) {
        super('hello');

        //! shared memory.
        // WARN! - `serverless offline`는 상태를 유지하지 않으므로, NODES값들이 실행때마다 리셋이될 수 있음.
        this.NODES = [{ name: 'lemon' }, { name: 'cloud' }];
        this.service = service ? service : $service;
        this.$kms = $kms || new AWSKMSService();
        this.$sns = $sns || new AWSSNSService();
        this.$s3s = $s3s || new AWSS3Service();

        //! attach sns listener
        $core.cores.lambda.sns.addListener(this.postHelloEvent);
    }

    /**
     * name of this resource.
     */
    public hello = () => `hello-api-controller:${this.type()}`;

    /**
     * list hello
     *
     * ```sh
     * $ http ':8086/hello'
     */
    public listHello: NextHandler = (ID, $param, $body, $ctx) => {
        _log(NS, `listHello(${ID})....`);

        const that: any = {};
        that.name = $U.env('NAME'); // read via process.env
        return Promise.resolve(that).then(_ => {
            _.list = this.NODES;
            return _;
        });
    };

    /**
     * get hello hello
     *
     * ```sh
     * $ http ':8086/hello/0'
     */
    public getHello: NextHandler = async (id, param, body, context) => {
        _log(NS, `getHello(${id})...`);
        _log(NS, `> context =`, $U.json(context));
        return { id, hello: this.hello(), context };
    };

    /**
     * Only Update with incremental support
     *
     * ```sh
     * $ echo '{"size":1}' | http PUT ':8888/hello/1'
     */
    public putHello: NextHandler = async (ID, $param, $body, $ctx) => {
        _log(NS, `do_put_hello(${ID})....`);
        $param = $param || {};

        return this.getHello(ID, null, null, $ctx).then(node => {
            const id = node._id || node.id || ID;
            Object.assign(this.NODES[id], $body || {});
            return Object.assign(node, $body || {});
        });
    };

    /**
     * Insert new Node at position 0.
     *
     * ```sh
     * $ echo '{"name":"lemoncloud"}' | http POST ':8888/hello/0'
     */
    public postHello: NextHandler = async (ID, $param, $body, $ctx) => {
        _log(NS, `postHello(${ID})....`);
        if (ID == 'echo') return { id: '!', cmd: 'echo', param: $param, body: $body, context: $ctx };
        //! do some thing.
        $param = $param || {};
        if (!$body || !$body.name) return Promise.reject(new Error('.name is required!'));
        return Promise.resolve($body).then(node => {
            this.NODES.push(node);
            return this.NODES.length - 1; // returns ID.
        });
    };

    /**
     * Post message via Slack Web Hook
     *
     * ```sh
     * # post message to slack/general
     * $ echo '{"text":"hello"}' | http ':8888/hello/public/slack'
     * $ echo '{"text":"hello"}' | http ':8888/hello/alarm/slack'
     *
     * # use sample
     * $ cat data/error-hello.json | http ':8888/hello/public/slack'
     * ```
     * @param {*} id                slack-channel id (see environment)
     * @param {*} $param            (optional)
     * @param {*} $body             {error?:'', message:'', data:{...}}
     * @param {*} $ctx              context
     */
    public postHelloSlack: NextHandler = async (id, $param, $body, $ctx) => {
        _log(NS, `postHelloSlack(${id})....`);
        _log(NS, '> body =', $body);
        $param = $param || {};

        //! load target webhook via environ.
        // TODO chain code 풀기.
        return this.service
            .do_load_slack_channel(id, 0 ? '' : 'public')
            .then(webhook => {
                _log(NS, '> webhook :=', webhook);
                //! prepare slack message via body.
                const message = typeof $body === 'string' ? { text: $body } : $body;
                const noop = (_: any) => _;
                //NOTE! filter message only if sending to slack-hook.
                const fileter = webhook.startsWith('https://hooks.slack.com') ? this.service.message_save_to_s3 : noop;
                return Promise.resolve(message)
                    .then(fileter)
                    .then(message => postMessage(webhook, message));
            })
            .catch(e => {
                //! ignore error, or it will make recursive error-report.
                _err(NS, `! slack[${id}].err =`, e);
                return '';
            });
    };

    /**
     * Event Handler via SNS
     *
     * ```sh
     * # alarm data
     * $ cat data/alarm.json | http ':8888/hello/!/event?subject=ALARM: test'
     * # delivery failure
     * $ cat data/delivery-failure.json | http ':8888/hello/!/event?subject=DeliveryFailure test'
     * # error case
     * $ cat data/error-1.json | http ':8888/hello/!/event?subject=error'
     * $ cat data/error-2.json | http ':8888/hello/!/event?subject=error'
     * $ cat data/error-2.json | http ':8888/hello/!/event?subject=error/alarm'
     * $ cat data/error-2.json | http ':8888/hello/!/event?subject=callback/alarm'
     */
    public postHelloEvent: NextHandler = (id, $param, $body, $ctx) => {
        _inf(NS, `postHelloEvent(${id})....`);
        $param = $param || {};
        const subject = `${$param.subject || ''}`;
        const data = $body;
        const context = $ctx;
        const noop = (_: any) => _;

        //! decode next-chain.
        const chain_next = false
            ? null
            : subject.startsWith('ALARM:')
            ? this.service.process_alarm
            : subject.startsWith('DeliveryFailure')
            ? this.service.process_delivery_failure
            : subject === 'error' || subject.startsWith('error/')
            ? this.service.process_error
            : subject === 'callback' || subject.startsWith('callback/')
            ? this.service.process_callback
            : subject === 'slack' || subject.startsWith('slack/')
            ? this.service.process_slack
            : noop;

        // TODO disable to chain
        const { channel, body } = chain_next({ subject, data, context }) as ParamForSlack;
        return this.postHelloSlack(channel, {}, body, $ctx);
    };

    /**
     * Read the channel url.
     *
     * ```sh
     * $ http ':8888/hello/public/test-channel'
     */
    public getHelloTestChannel: NextHandler = async (id, $param, $body, $ctx) => {
        _log(NS, `do_get_test_channel(${id})....`);
        return this.service.do_load_slack_channel(id).then((channel: string) => {
            return { id, channel };
        });
    };

    /**
     * Read the detailed object.
     *
     * ```sh
     * $ http ':8888/hello/alarm/test-sns'
     * $ http ':8888/hello/failure/test-sns'
     */
    public getHelloTestSns: NextHandler = async (ID, $param, $body, $ctx) => {
        _log(NS, `getHelloTestSns(${ID})....`);

        //! build event body, then start promised
        const build_event_chain = (subject: string, data: any) => {
            //! clear internals
            data = Object.keys(data).reduce((N: any, key) => {
                if (!key.startsWith('!')) N[key] = data[key];
                return N;
            }, {});
            //! prepare event body.
            const event = {
                Records: [
                    {
                        Sns: {
                            Subject: subject || 'ALARM: "...." in Asia Pacific (Seoul)',
                            Message: data,
                        },
                    },
                ],
            };
            return Promise.resolve(event);
        };

        //! call sns handler.
        const local_chain_handle_sns = (event: any) => {
            // if (event) return event;
            //! validate event
            event = event || {};
            if (!event.Records || !Array.isArray(event.Records))
                return Promise.reject(new Error('.Records[] is required!'));
            if (!event.Records[0] || !event.Records[0].Sns)
                return Promise.reject(new Error('.Records[0].Sns is required!'));
            if (!event.Records[0].Sns.Subject || !event.Records[0].Sns.Message)
                return Promise.reject(new Error('.Records[0].Sns.Subject is required!'));

            //! call handler.
            return $core.cores.lambda.sns.handle(event, null);
        };

        //! decode by ID
        return (() => {
            if (ID == 'alarm') {
                const data = loadJsonSync('data/alarm.json');
                return build_event_chain('ALARM: "...." in Asia Pacific (Seoul)', data);
            }
            if (ID == 'failure') {
                const data = loadJsonSync('data/delivery-failure.json');
                return build_event_chain(data['!Subject'] || 'DeliveryFailure', data);
            }
            return Promise.reject(new Error(`404 NOT FOUND - test-sns:${ID}`));
        })().then(local_chain_handle_sns);
    };

    /**
     * Test SNS ARN
     *
     * ```sh
     * $ http ':8888/hello/0/test-sns-arn'
     */
    public getHelloTestSnsArn: NextHandler = async (ID, $param, $body, $ctx) => {
        _log(NS, `getHelloTestSnsArn(${ID})....`);
        const arn = await this.$sns.endpoint('');
        _log(NS, '> arn =', arn);
        return { arn };
    };

    /**
     * Test SNS Report Error
     *
     * ```sh
     * $ http ':8888/hello/0/test-sns-err'
     */
    public getHelloTestSnsErr: NextHandler = async (ID, $param, $body, $ctx) => {
        _log(NS, `getHelloTestSnsErr(${ID})....`);
        const e = new Error('Test Error');
        const mid = await this.$sns.reportError(e, undefined, undefined);
        _log(NS, '> message-id =', mid);
        return { mid };
    };

    /**
     * Encrypt Test.
     *
     * ```sh
     * $ http ':8888/hello/0/test-encrypt'
     */
    public getHelloTestEncrypt: NextHandler = async (ID, $param, $body, $ctx) => {
        _log(NS, `getHelloTestEncrypt(${ID})....`);
        const message = 'hello lemon';
        const encrypted = await this.$kms.encrypt(message);
        const decrypted = await this.$kms.decrypt(encrypted);
        const _ = { encrypted, decrypted, message };
        const result = _.encrypted && _.message === _.decrypted;
        return Object.assign(_, { result });
    };

    /**
     * Raise Error
     *
     * ```sh
     * $ http ':8888/hello/0/test-error'
     * $ http ':8888/hello/0/test-error?report=1'
     */
    public getHelloTestError: NextHandler = async (ID, $param, $body, $ctx) => {
        _log(NS, `getHelloTestError(${ID})....`);
        const report = $U.N($param.report, $param.report === '' ? 1 : 0);
        if (report) return await doReportError(new Error('hello-error'), null, null);
        throw new Error('hello lemon');
    };

    /**
     * Test Env
     *
     * ```sh
     * $ http ':8888/hello/0/test-env'
     */
    public getHelloTestEnv: NextHandler = async (ID, $param, $body, $ctx) => {
        _log(NS, `getHelloTestEnv(${ID})....`);
        const report = $U.N($param.report, $param.report === '' ? 1 : 0);
        const env = process.env;
        return { env };
    };

    /**
     * Test S3 PutObject.
     *
     * ```sh
     * $ http ':8888/hello/0/test-s3-put'
     */
    public getHelloTestS3Put: NextHandler = (ID, $param, $body, $ctx) => {
        _log(NS, `getHelloTestS3Put(${ID})....`);
        const message = 'hello lemon';
        const data = { message };
        const json = JSON.stringify(data);
        return this.$s3s.putObject(json);
    };
}

//! export as default.
export default new HelloAPIController();
