# Changelog

## 1.0.0 (2026-09-02)


### Features

* add a self-hosted Convex backend for local development ([53bf4a8](https://github.com/christianstamati/mnlth/commit/53bf4a80e88ebf7958ac9e9b33f800bc64c903a4))
* **chat:** name the author of each message ([6486a3a](https://github.com/christianstamati/mnlth/commit/6486a3a4d81bba1a85bfe14d60b284ead46b4eb0))
* **ci:** deploy branches, pull requests and production from GitHub Actions ([69424ca](https://github.com/christianstamati/mnlth/commit/69424ca97acaa03d00b727a7901c5949029f0bbf))
* **ci:** releases via release-please, announced in Slack ([0df0017](https://github.com/christianstamati/mnlth/commit/0df00171e1052fb1a998f4ab2801e1541b746ee6))
* **convex-backend:** elasticIp, S3 storage and managed database options ([e344329](https://github.com/christianstamati/mnlth/commit/e34432933b8ecf666022a393bf61920f63c330b7))
* **convex-backend:** keep the wildcard certificate in a shared S3 bucket ([371af34](https://github.com/christianstamati/mnlth/commit/371af348a0c49c62669fec1789dfbfc2d095dbff))
* **convex-backend:** MySQL 8.4, co-located RDS, stage-named instance, SSH access ([5772ff3](https://github.com/christianstamati/mnlth/commit/5772ff3fc5845aedfc6ebf3d55c6a7c0a68c1977))
* **convex-backend:** one wildcard certificate per stage, flat hostnames ([ed66a5d](https://github.com/christianstamati/mnlth/commit/ed66a5d66461fa66af0dcc9ef20fa53c0bcf7bdf))
* ConvexBackend SST component for self-hosted Convex on EC2 behind Caddy ([d2af5c2](https://github.com/christianstamati/mnlth/commit/d2af5c22463c16bc765dd7741e073d39b8a207a5))
* **dev:** the local dashboard signs in by itself ([63a56e5](https://github.com/christianstamati/mnlth/commit/63a56e5e06976d5d63fb456ce0529545ce1d7131))
* **dev:** turbo owns the local loop ([cfb3ce1](https://github.com/christianstamati/mnlth/commit/cfb3ce14faa6364b9282b8be6f9be50d4b64f200))
* expose stage name to the web app ([a32268a](https://github.com/christianstamati/mnlth/commit/a32268ae8874d38eb199c1f324e0638091e31f0e))
* gate the production guard on SST_UNPROTECT instead of a constant ([3b3ed0e](https://github.com/christianstamati/mnlth/commit/3b3ed0e01b223b50250a8422182fe7c20a0b7549))
* initial commit ([1a483af](https://github.com/christianstamati/mnlth/commit/1a483af4f501e05e0975249ab6a3075011e63929))
* **local:** run the dev processes through turbo's TUI [skip ci] ([08142f5](https://github.com/christianstamati/mnlth/commit/08142f5f297d0b47b3d616367acbddad76bb6609))
* look up the shared router distribution id from ssm ([f7aba15](https://github.com/christianstamati/mnlth/commit/f7aba1599187f5ecd4ff3d4e5473834f9b6260b1))
* name the shared database password secret explicitly ([24d9b2b](https://github.com/christianstamati/mnlth/commit/24d9b2b25bf4c63b078a7af8b2499af785ca126b))
* share one cloudfront router across stages ([dd91038](https://github.com/christianstamati/mnlth/commit/dd91038aaf433eb1ffdbc3d782ef054165014cbf))
* share the VPC and Postgres server across stages ([66a7b08](https://github.com/christianstamati/mnlth/commit/66a7b08b20e9c6d02ecd2f9da4dc781fe39431a8))
* ship the frontend, with S3 storage and a stable Convex identity ([483f9d7](https://github.com/christianstamati/mnlth/commit/483f9d7d2f8ba8d1abc5bbb50a0b409f0c66e956))
* **sst:** move domain, region and lifecycle policy to sst.settings.json ([b734a33](https://github.com/christianstamati/mnlth/commit/b734a33403368496f35ce3004ec5fd3f127856cf))
* **sst:** only domain and region are required in sst.settings.json ([b741d2d](https://github.com/christianstamati/mnlth/commit/b741d2d32db16650542a198a7daafff5bdca3ce3))
* **sst:** per-stage storage and database in sst.settings.json ([1dc5236](https://github.com/christianstamati/mnlth/commit/1dc52368933b31f8eebb652f49d27a5fc8e28c9a))
* **web:** TanStack Start on a shared Router, and Convex functions pushed on deploy ([06feedc](https://github.com/christianstamati/mnlth/commit/06feedc1b48ca65583117461aff4a2a84a5b69e1))


### Bug Fixes

* **ci:** grant the deploy workflow its permissions from the callers ([67040cd](https://github.com/christianstamati/mnlth/commit/67040cdde3e93dec14160f799d9c2d6f981ddf9e))
* **convex-backend:** retry image pulls at boot ([c5f0936](https://github.com/christianstamati/mnlth/commit/c5f09362b9a853de5fe4c112d95357cbc423ed59))
* **convex-backend:** retry image pulls for up to 20 minutes ([729cccc](https://github.com/christianstamati/mnlth/commit/729cccc32472b66c062ae4fcd92cbee95f4c4014))
* **convex-backend:** wait for Route 53 sync before the DNS-01 challenge ([f0a5650](https://github.com/christianstamati/mnlth/commit/f0a5650371de7411f2c731736631154eeb4e139e))
* **convex-deploy:** wait for the backend to answer before pushing ([0224fcc](https://github.com/christianstamati/mnlth/commit/0224fcc9bae61633a5d5650256fa97d4362dd807))
* **dev:** keep the local admin key between runs ([a0143ae](https://github.com/christianstamati/mnlth/commit/a0143aea92a56265d860852ca183957b04c90fc5))
* import node:crypto dynamically inside run() ([53564da](https://github.com/christianstamati/mnlth/commit/53564daa54b2d536db3e6c2040f05915eddafab2))
* **local:** build paths with fileURLToPath so bun local works on Windows [skip ci] ([c9c1152](https://github.com/christianstamati/mnlth/commit/c9c11527b66e9139a360cf0ad9cbbd27699e4b77))
* **local:** restore the existsSync import [skip ci] ([4530941](https://github.com/christianstamati/mnlth/commit/4530941f602ab82cc8b7cc83dd2daddca13f38a8))
* make production own the shared infra and harden the instance ([737eec8](https://github.com/christianstamati/mnlth/commit/737eec8aa187eceb727068a7b30049c9c7d20549))
* refuse to deploy production over a shared VPC it does not own ([385e578](https://github.com/christianstamati/mnlth/commit/385e5785c7b0e080c4a32894fd82eb578fdaaea2))
* **sst:** drop the key pair the account no longer has ([a86c7db](https://github.com/christianstamati/mnlth/commit/a86c7db868cc9735cb011fa40119e9d78a2e2f9a))
* **sst:** load settings with dynamic imports; SST forbids top-level imports ([61a9e59](https://github.com/christianstamati/mnlth/commit/61a9e59e6c9885391ba25ebd2dc69105f7bfd456))
* **teardown:** keep the sst-asset ECR repository with the rest of the SST bootstrap ([8039f42](https://github.com/christianstamati/mnlth/commit/8039f424cee151274787200e482b1e61eaffca20))


### Performance Improvements

* **convex-backend:** fetch a prebuilt Caddy release instead of building on boot ([341db1b](https://github.com/christianstamati/mnlth/commit/341db1bd8d515adaaf06f169ef21bc589e82fdfd))
