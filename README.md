## Configuration

Create a `.env` file in the project root and set the following environment variables:

```env
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=...
EC2_INSTANCE_ID=...
PROXY_PORT=25565
SHUTDOWN_IDLE_MINUTES=10
```

Replace the placeholder values with your own AWS credentials, EC2 instance ID, proxy port, and idle shutdown timeout.

Once your `.env` is in place, define your routing rules as shown below.

# Sample `routes.json`

Below is an example `routes.json` configuration for the Minecraft proxy:

```json
{
    "mc.example.com": {
        "type": "ec2"
    },
    "us.example.com": {
        "type": "local",
        "host": "127.0.0.1",
        "port": 25566
    },
    "*.party.example.com": {
        "type": "local",
        "host": "127.0.0.1",
        "port": 25567
    },
    "example.com": {
        "type": "local",
        "host": "127.0.0.1",
        "port": 25565
    }
}
```