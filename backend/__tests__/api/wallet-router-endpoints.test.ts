jest.mock("../../src/lib/tokens", () => ({
  verifyAccessToken: jest.fn(),
}));

import { apiRouter } from "../../src/routes";


describe("apiRouter wallet endpoint registrations", () => {
  it("registers GET /api/wallet/balance on apiRouter", () => {
    const route = apiRouter.stack.find(
      (layer: any) =>
        layer.route &&
        layer.route.path === "/api/wallet/balance" &&
        layer.route.methods.get === true
    );
    expect(route).toBeDefined();
    expect(route?.route?.methods).toEqual(expect.objectContaining({ get: true }));
  });

  it("registers GET /api/wallet/banks on apiRouter", () => {
    const route = apiRouter.stack.find(
      (layer: any) =>
        layer.route &&
        layer.route.path === "/api/wallet/banks" &&
        layer.route.methods.get === true
    );
    expect(route).toBeDefined();
    expect(route?.route?.methods).toEqual(expect.objectContaining({ get: true }));
  });

  it("registers POST /api/wallet/banks on apiRouter", () => {
    const route = apiRouter.stack.find(
      (layer: any) =>
        layer.route &&
        layer.route.path === "/api/wallet/banks" &&
        layer.route.methods.post === true
    );
    expect(route).toBeDefined();
    expect(route?.route?.methods).toEqual(expect.objectContaining({ post: true }));
  });

  it("registers PUT /api/wallet/banks/:id on apiRouter", () => {
    const route = apiRouter.stack.find(
      (layer: any) =>
        layer.route &&
        layer.route.path === "/api/wallet/banks/:id" &&
        layer.route.methods.put === true
    );
    expect(route).toBeDefined();
    expect(route?.route?.methods).toEqual(expect.objectContaining({ put: true }));
  });

  it("registers DELETE /api/wallet/banks/:id on apiRouter", () => {
    const route = apiRouter.stack.find(
      (layer: any) =>
        layer.route &&
        layer.route.path === "/api/wallet/banks/:id" &&
        layer.route.methods.delete === true
    );
    expect(route).toBeDefined();
    expect(route?.route?.methods).toEqual(expect.objectContaining({ delete: true }));
  });
});
